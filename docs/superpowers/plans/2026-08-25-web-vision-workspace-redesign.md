# Web Vision Workspace Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the non-interactive OpenCV toolbar embedded in MJPEG with a reliable session-based camera preview and browser-native visual workspace.

**Architecture:** Python owns a single explicit vision session state machine and publishes structured status plus one shared MJPEG encoding. Go remains the only browser-facing entry and converts backend outages into structured errors. React renders a clean video with an SVG interaction layer whose actions are bound to the active session ID.

**Tech Stack:** Python 3.14, Flask/Waitress, OpenCV, Go 1.25, Gorilla WebSocket, React 19, Vite 8, Node test runner.

**Spec:** `docs/superpowers/specs/2026-08-25-web-vision-workspace-redesign.md`

## Global Constraints

- Python listens only on `127.0.0.1`; browsers access it only through Go.
- First release remains MJPEG at 640×480, at most 20 FPS, JPEG quality 50.
- Only one camera and one visual-control target may be active at a time.
- Every session-bound action carries an unpredictable `sessionId`.
- Every visual failure stops machine-fish control before resources are released.
- Existing YOLO, calibration, navigation, and ESP32 command algorithms remain in Python.
- The OpenCV toolbar is not part of the formal video stream; a debug window remains opt-in only.
- This workspace is not a Git repository. Replace commit steps with the named verification checkpoint and record changed files in the task handoff.

## File Map

- Create `vision/session.py`: state enum, session snapshots, legal transitions, structured errors.
- Create `vision/tests/test_session.py`: state and stale-session contract.
- Modify `vision/service.py`: camera validation and lifecycle orchestration.
- Modify `vision/server.py`: runner completion callback and structured failure propagation.
- Modify `vision/web_api.py`: session REST endpoints and compatibility routing.
- Modify `vision/interface.py`: safe camera open and shared JPEG frame publisher.
- Modify `vision/main.py`: preview/processing split and clean presentation mode.
- Modify `vision/ui.py`: render machine-vision overlays without the legacy toolbar.
- Modify `controller/internal/visionproxy/proxy.go`: structured backend-unavailable errors and session stream routing.
- Modify `controller/internal/visionproxy/proxy_test.go`: Go proxy contract.
- Create `controller/frontend/src/visionSession.js`: frontend session reducer and API helpers.
- Create `controller/frontend/src/visionSession.test.js`: state and error tests.
- Create `controller/frontend/src/VisionOverlay.jsx`: SVG interaction layer.
- Create `controller/frontend/src/visionOverlay.js`: coordinate and draft-geometry functions.
- Create `controller/frontend/src/visionOverlay.test.js`: geometry tests.
- Modify `controller/frontend/src/VisionPanel.jsx`: new workspace composition.
- Modify `controller/frontend/src/styles.css`: responsive video workspace styling.
- Modify `README.md` and `docs/项目架构与开发方案.md`: operating and troubleshooting instructions.

---

### Task 1: Reliable camera validation

**Files:**
- Modify: `vision/service.py`
- Modify: `vision/interface.py`
- Test: `vision/tests/test_service.py`

**Interfaces:**
- Produces: `probe_camera(index: int, opener=None, timeout_s: float = 3.0) -> CameraProbe`
- Produces: `CameraProbe(index, name, width, height, fps, readable, error_code)`
- Produces: `CameraStream.open(src: int, opener=None) -> CameraStream`

- [ ] **Step 1: Add failing camera-probe tests**

Add fakes with `set()`, `read()` and `release()`, then assert that an opened handle without a valid frame is excluded and always released:

```python
def test_enumeration_excludes_camera_that_cannot_deliver_first_frame(self):
    capture = FakeCapture(opened=True, frames=[(False, None)] * 3)
    cameras = enumerate_cameras(
        max_index=1,
        open_capture=lambda _index: capture,
        name_provider=lambda: ["Broken Virtual Camera"],
    )
    self.assertEqual(cameras, [])
    self.assertTrue(capture.released)

def test_driver_property_exception_does_not_escape_probe(self):
    capture = FakeCapture(opened=True, set_error=RuntimeError("driver rejected"))
    probe = probe_camera(0, opener=lambda _index: capture, timeout_s=0)
    self.assertFalse(probe.readable)
    self.assertEqual(probe.error_code, "camera_configuration_failed")
```

- [ ] **Step 2: Run the focused test and verify RED**

Run: `cd vision && python -m unittest discover -s tests -p test_service.py -v`  
Expected: FAIL because `probe_camera` does not exist and enumeration accepts `isOpened()` without a frame.

- [ ] **Step 3: Implement the probe and safe open path**

Use a deadline-based first-frame loop; catch `cv2.error`, `OSError` and runtime driver exceptions around open, property configuration and read. Return `fps=None` when the reported value is non-finite or `<= 0`. Release the probe handle in `finally`. Make `CameraStream.open()` raise a typed `CameraOpenError(code, message)` instead of exposing raw OpenCV exceptions.

- [ ] **Step 4: Verify camera tests GREEN**

Run: `cd vision && python -m unittest discover -s tests -p test_service.py -v`  
Expected: all camera enumeration and lifecycle tests pass.

- [ ] **Step 5: Record checkpoint**

Record: `camera-probe` — `vision/service.py`, `vision/interface.py`, `vision/tests/test_service.py`.

### Task 2: Explicit vision session state machine

**Files:**
- Create: `vision/session.py`
- Create: `vision/tests/test_session.py`
- Modify: `vision/service.py`

**Interfaces:**
- Produces: `VisionState(str, Enum)` with `idle/opening/previewing/processing/tracking/stopping/error`
- Produces: `VisionSession.snapshot() -> dict`
- Produces: `VisionSession.transition(target: VisionState) -> None`
- Produces: `VisionService.require_session(session_id: str) -> VisionSession`

- [ ] **Step 1: Write failing transition and stale-session tests**

```python
def test_session_rejects_illegal_transition():
    session = VisionSession.new(camera_id="camera-1")
    with self.assertRaises(InvalidTransition):
        session.transition(VisionState.TRACKING)

def test_old_session_id_is_rejected_after_stop_and_restart():
    first = service.create_session("camera-1")
    service.stop_session(first["sessionId"])
    second = service.create_session("camera-1")
    self.assertNotEqual(first["sessionId"], second["sessionId"])
    with self.assertRaises(SessionMismatch):
        service.handle_session_action(first["sessionId"], {"type": "path.clear"})
```

- [ ] **Step 2: Run and verify RED**

Run: `cd vision && python -m unittest discover -s tests -p test_session.py -v`  
Expected: import failure for the missing session module.

- [ ] **Step 3: Implement minimal state and snapshot types**

Use `secrets.token_urlsafe(24)` for IDs. Store `state`, `sessionId`, `cameraId`, `cameraIndex`, `error`, `metrics` and `lastAction` in the snapshot. Encode legal transitions in one mapping and raise typed `InvalidTransition` and `SessionMismatch` exceptions.

- [ ] **Step 4: Integrate the state object into `VisionService`**

Replace `_stop_runner` as the source of truth. Keep resource handles private, but derive all public status from the active `VisionSession`. Stop must enter `stopping`, invoke resource cleanup, clear queued actions, then end at `idle`; failures end at `error` only after cleanup.

- [ ] **Step 5: Run session and service tests**

Run: `cd vision && python -m unittest discover -s tests -p 'test_session.py' -v`  
Run: `cd vision && python -m unittest discover -s tests -p 'test_service.py' -v`  
Expected: both commands pass.

- [ ] **Step 6: Record checkpoint**

Record: `vision-session-state` — new state model and service integration.

### Task 3: Separate preview from visual processing

**Files:**
- Modify: `vision/main.py`
- Modify: `vision/server.py`
- Modify: `vision/service.py`
- Test: `vision/tests/test_server_runner.py`
- Test: `vision/tests/test_service.py`

**Interfaces:**
- Produces: `start_preview_runner(camera_index, frame_publisher, on_exit) -> PreviewRunner`
- Produces: `PreviewRunner.start_processing(action_source) -> None`
- Produces: `PreviewRunner.stop_processing() -> None`
- Produces: `PreviewRunner.close() -> None`

- [ ] **Step 1: Write failing lifecycle tests**

```python
def test_preview_delivers_frames_without_starting_detector(self):
    runner = factory.start_preview(1)
    self.assertTrue(runner.camera_started)
    self.assertFalse(runner.detector_started)
    runner.start_processing()
    self.assertTrue(runner.detector_started)

def test_runner_exit_updates_service_error_state(self):
    runner = factory.start_preview(1)
    runner.fail(CameraOpenError("camera_read_failed", "lost camera"))
    self.assertEqual(service.status()["state"], "error")
    self.assertEqual(service.status()["error"]["code"], "camera_read_failed")
```

- [ ] **Step 2: Run and verify RED**

Run: `cd vision && python -m unittest discover -s tests -p 'test_server_runner.py' -v`  
Expected: FAIL because preview and processing are not separable and runner exit has no callback.

- [ ] **Step 3: Split resource ownership**

Move camera and MJPEG startup into preview lifecycle. Start `FishDetector`, `VisionPipeline` and processing loop only on `start_processing`. Ensure `close()` is idempotent and orders safety stop → recorder close → detector close → MJPEG close → camera release.

- [ ] **Step 4: Add runner completion callback**

The worker thread must call `on_exit(error=None)` in `finally`. Service verifies the callback belongs to the current session before changing state so an old worker cannot overwrite a new session.

- [ ] **Step 5: Verify focused and full Python tests**

Run: `cd vision && python -m unittest discover -s tests -v`  
Expected: all tests pass, including preview-only and unexpected-exit coverage.

- [ ] **Step 6: Record checkpoint**

Record: `preview-processing-split`.

### Task 4: Session REST API and structured Go proxy errors

**Files:**
- Modify: `vision/web_api.py`
- Modify: `vision/tests/test_web_api.py`
- Modify: `controller/internal/visionproxy/proxy.go`
- Modify: `controller/internal/visionproxy/proxy_test.go`

**Interfaces:**
- Consumes: session service from Tasks 2–3.
- Produces: endpoints defined in spec section 8.
- Produces: Go JSON error `{ok:false,error:{code:"vision_backend_unavailable",message:string}}`.

- [ ] **Step 1: Add failing Python API tests**

Test create/current/process/action/delete and stale IDs. Assert `POST /sessions` returns `previewing`, invalid camera returns structured `camera_open_failed`, and stale actions return HTTP 409 with `session_mismatch`.

- [ ] **Step 2: Run Python API test and verify RED**

Run: `cd vision && python -m unittest discover -s tests -p test_web_api.py -v`  
Expected: 404 for new session endpoints.

- [ ] **Step 3: Implement the Flask session routes**

Create one response helper:

```python
def response(snapshot, ok=True, error=None, status=200):
    return jsonify({
        "ok": ok,
        "state": snapshot["state"],
        "sessionId": snapshot.get("sessionId"),
        "data": snapshot,
        "error": error,
    }), status
```

Keep `/start`, `/stop`, `/status`, `/action` temporarily mapped to the new service for compatibility; add a response header `Deprecation: true`.

- [ ] **Step 4: Add failing Go proxy outage and stream-path tests**

Assert a dead Python upstream produces HTTP 503 JSON, not raw 502 text. Assert `/api/vision/sessions/abc/stream.mjpg` maps to Python `/sessions/abc/stream.mjpg` without rewriting other session paths.

- [ ] **Step 5: Implement Go proxy handling**

Set `ReverseProxy.ErrorHandler` to emit the structured 503 response. Preserve session paths and `sessionId`; keep the Python hosts fixed to loopback configuration.

- [ ] **Step 6: Verify contracts**

Run: `cd vision && python -m unittest discover -s tests -p test_web_api.py -v`  
Run: `cd controller && go test ./internal/visionproxy ./internal/web`  
Expected: all pass.

- [ ] **Step 7: Record checkpoint**

Record: `session-api-proxy-contract`.

### Task 5: Shared JPEG publisher and clean video rendering

**Files:**
- Modify: `vision/interface.py`
- Modify: `vision/ui.py`
- Modify: `vision/main.py`
- Modify: `vision/tests/test_mjpeg_capacity.py`
- Create: `vision/tests/test_clean_presentation.py`

**Interfaces:**
- Produces: `SharedJpegPublisher.update(frame: np.ndarray) -> None`
- Produces: `SharedJpegPublisher.stream(session_id: str) -> Iterator[bytes]`
- Produces: metrics `encodeFps`, `averageJpegBytes`, `viewerCount`.

- [ ] **Step 1: Write failing shared-encoding test**

Inject an encoder counter, attach two stream iterators, publish one frame and assert the encoder is called exactly once while both viewers receive the same JPEG payload.

- [ ] **Step 2: Write failing clean-presentation test**

Render a known frame in formal headless mode and assert `VisionToolbar.draw` is not called. Assert detection and confirmed trajectory overlay calls remain enabled.

- [ ] **Step 3: Run and verify RED**

Run: `cd vision && python -m unittest discover -s tests -p 'test_mjpeg_capacity.py' -v`  
Run: `cd vision && python -m unittest discover -s tests -p 'test_clean_presentation.py' -v`  
Expected: multiple encodes or missing clean mode.

- [ ] **Step 4: Implement shared encoding**

Encode in `update()` at no more than 20 FPS with 640×480 output and JPEG quality 50. Store immutable latest JPEG bytes plus a monotonically increasing sequence under a condition variable. Viewer generators wait for a new sequence and only frame the already encoded bytes.

- [ ] **Step 5: Remove formal-stream toolbar rendering**

Add an explicit presentation mode such as `web_clean=True`. In this mode omit toolbar buttons and low-frequency diagnostic panels; keep only algorithm overlays necessary to interpret detections. Do not change debug-window rendering.

- [ ] **Step 6: Verify Python suite**

Run: `cd vision && python -m unittest discover -s tests -v`  
Expected: all tests pass and the encoder-count assertion is exactly one.

- [ ] **Step 7: Record checkpoint**

Record: `shared-clean-mjpeg`.

### Task 6: Frontend session client and authoritative state

**Files:**
- Create: `controller/frontend/src/visionSession.js`
- Create: `controller/frontend/src/visionSession.test.js`
- Modify: `controller/frontend/src/VisionPanel.jsx`

**Interfaces:**
- Produces: `visionReducer(state, event) -> state`
- Produces: `createVisionClient(fetchImpl)` with `listCameras/createSession/startProcessing/stopProcessing/sendAction/stopSession/getCurrent`.
- Consumes: Task 4 response envelope.

- [ ] **Step 1: Write failing reducer tests**

Cover `idle → opening → previewing`, processing, tracking, error, stop, new session clearing old drafts, and backend outage. Assert tools are enabled only in `processing` and stop remains enabled in `previewing/processing/tracking/error` when a session ID exists.

- [ ] **Step 2: Run and verify RED**

Run: `cd controller/frontend && npm test -- --run`  
Expected: missing `visionSession.js`.

- [ ] **Step 3: Implement reducer and client**

The client checks both HTTP status and response `ok`. It throws `VisionApiError(code, message, snapshot)`. The reducer never infers running state from an `<img>` load event; `GET /sessions/current` is authoritative.

- [ ] **Step 4: Replace polling and old endpoints in `VisionPanel`**

Poll the authoritative snapshot while a session exists and at a slower idle interval otherwise. Bind the MJPEG source to `/api/vision/sessions/{sessionId}/stream.mjpg`. Stop retries immediately when state is not `previewing`, `processing`, or `tracking`.

- [ ] **Step 5: Verify frontend tests and build**

Run: `cd controller/frontend && npm test -- --run`  
Run: `cd controller/frontend && npm run build`  
Expected: all tests pass and Vite writes embedded assets to `controller/internal/web/dist`.

- [ ] **Step 6: Record checkpoint**

Record: `frontend-session-client`.

### Task 7: Browser-native visual overlay

**Files:**
- Create: `controller/frontend/src/VisionOverlay.jsx`
- Create: `controller/frontend/src/visionOverlay.js`
- Create: `controller/frontend/src/visionOverlay.test.js`
- Modify: `controller/frontend/src/VisionPanel.jsx`
- Modify: `controller/frontend/src/styles.css`

**Interfaces:**
- Produces: `videoContentRect(containerRect, videoWidth, videoHeight) -> Rect`
- Produces: `toSourcePoint(pointer, contentRect, sourceSize) -> Point`
- Produces: `VisionOverlay({session, tool, sourceSize, confirmed, onAction})`.

- [ ] **Step 1: Write failing geometry tests**

Test exact mapping for same aspect ratio, letterboxing, pillarboxing, device-pixel-ratio independence and clipping. Test a path draft emits at least two points and marker ROI normalizes reverse-direction dragging.

- [ ] **Step 2: Run and verify RED**

Run: `cd controller/frontend && npm test -- --run`  
Expected: missing overlay module.

- [ ] **Step 3: Implement pure geometry helpers**

Keep all calculations independent of React and DOM. `videoContentRect` derives the visible `object-fit: contain` rectangle. `toSourcePoint` returns integer source pixels.

- [ ] **Step 4: Implement the SVG overlay component**

Use pointer capture. Render numbered calibration points, ROI rectangle, heading arrow and path polyline. Keep draft geometry local; call `onAction({type, ...coordinates})` on completion. Remove a draft only after success; on rejection, restore the last confirmed server snapshot and show the structured error.

- [ ] **Step 5: Compose the new workspace**

Place `<img>` and `<VisionOverlay>` in the same aspect-ratio stage. Replace the old single start button with “开始预览”, “停止预览”, “启动视觉处理” and “停止视觉处理”. Disable editing while tracking.

- [ ] **Step 6: Verify frontend suite and build**

Run: `cd controller/frontend && npm test -- --run`  
Run: `cd controller/frontend && npm run build`  
Expected: all tests pass and build succeeds.

- [ ] **Step 7: Record checkpoint**

Record: `browser-vision-overlay`.

### Task 8: Integration, compatibility removal, and documentation

**Files:**
- Modify: `controller/frontend/src/VisionPanel.jsx`
- Modify: `vision/web_api.py`
- Modify: `README.md`
- Modify: `docs/项目架构与开发方案.md`
- Test: all existing suites

**Interfaces:**
- Consumes: Tasks 1–7.
- Produces: final session-only web vision workflow.

- [ ] **Step 1: Add an end-to-end contract test with fake camera and runner**

Drive: camera list → create preview → get first stream frame → start processing → draw path → receive accepted action → stop processing → delete session. Assert final state `idle`, no pending actions and all fake resources closed.

- [ ] **Step 2: Run the integration test and verify it can fail at each boundary**

Temporarily configure each fake boundary to fail once: camera first frame, processing startup, stale action and stream disconnect. Confirm each produces its specified error code, then restore the passing fixture.

- [ ] **Step 3: Remove frontend use of compatibility endpoints**

Search for `/api/vision/start`, `/stop`, `/status`, `/action` and `/stream.mjpg`. No frontend references may remain. Keep Python compatibility routes for one release only if external diagnostic scripts still use them; otherwise delete them with their old tests.

- [ ] **Step 4: Update operator documentation**

Document preview-first operation, structured errors, clean video output, tool behavior, safe stop, camera rescan and the 20-cycle hardware acceptance procedure. Remove statements that describe a single `running/stopped` lifecycle.

- [ ] **Step 5: Run complete verification**

Run: `cd vision && python -m unittest discover -s tests -v`  
Run: `cd controller && go test ./...`  
Run: `cd controller/frontend && npm test -- --run`  
Run: `cd controller/frontend && npm run build`  
Expected: zero failures and a successful production build.

- [ ] **Step 6: Run target-machine acceptance**

Perform the seven real-device checks in spec section 13, including 20 preview/stop/switch cycles, drawing interruption, camera unplug, two viewers and FPS/latency recording. Record camera names, selected IDs, failure codes and measured FPS without recording Wi-Fi credentials or deployment keys.

- [ ] **Step 7: Record final checkpoint**

Record: `web-vision-workspace-complete` with verification output and any remaining hardware-only limitations.

### Task 9: Verified camera exposure feedback

**Files:**
- Modify: `vision/interface.py`
- Modify: `vision/main.py`
- Modify: `vision/service.py`
- Modify: `vision/tests/test_actions.py`
- Modify: `vision/tests/test_service.py`
- Modify: `controller/frontend/src/VisionPanel.jsx`
- Modify: `controller/frontend/src/visionSession.test.js`

**Interfaces:**
- Produces: `CameraStream.adjust_exposure(delta: int) -> ExposureResult`
- Produces: `ExposureResult(status, supported, requested_delta, previous_value, actual_value, error_code)`
- Produces: session snapshot field `data.exposure`.

- [ ] **Step 1: Write failing driver-result tests**

Use a fake capture whose `set()` can return true or false and whose `get(CAP_PROP_EXPOSURE)` can change or remain fixed. Assert success only when the post-write value differs, `exposure_unsupported` when manual mode or exposure write is rejected, and `exposure_not_applied` when the driver reports success without changing the value.

- [ ] **Step 2: Run and verify RED**

Run: `cd vision && python -m unittest discover -s tests -p 'test_service.py' -v`  
Expected: FAIL because exposure adjustment returns no structured result.

- [ ] **Step 3: Implement verified exposure adjustment**

Read previous value, disable auto exposure, write the target, read actual value, and return a dataclass result. Catch `cv2.error`, `OSError` and driver runtime errors. Do not mutate the cached exposure value unless the read-back confirms application.

- [ ] **Step 4: Publish action completion**

Assign every action an `actionId`. Store the exposure completion in the current session `lastAction` and update `metrics.exposure`. Return `completed` only for confirmed read-back; return `failed` with the exact error code otherwise.

- [ ] **Step 5: Update the webpage**

Disable exposure buttons while the action is pending or when `exposure.supported` is false. Show `实际曝光：<value>` after success and the structured Chinese error after rejection.

- [ ] **Step 6: Verify Python and frontend tests**

Run: `cd vision && python -m unittest discover -s tests -v`  
Run: `cd controller/frontend && npm test -- --run`  
Run: `cd controller/frontend && npm run build`  
Expected: all pass.

- [ ] **Step 7: Record checkpoint**

Record: `verified-camera-exposure`.

### Task 10: ESP32 announce and authenticated controller offer

**Files:**
- Create: `firmware/include/ControllerOfferProtocol.h`
- Create: `firmware/src/ControllerOfferProtocol.cpp`
- Modify: `firmware/include/DiscoveryResponder.h`
- Modify: `firmware/src/DiscoveryResponder.cpp`
- Modify: `firmware/include/ControllerClient.h`
- Modify: `firmware/src/ControllerClient.cpp`
- Modify: `firmware/src/main.cpp`
- Create: `firmware/test/test_controller_offer/test_main.cpp`
- Modify: `controller/internal/discovery/protocol.go`
- Modify: `controller/internal/discovery/protocol_test.go`
- Modify: `controller/internal/discovery/service.go`
- Modify: `controller/cmd/fish-controller/main.go`
- Modify: `protocol/websocket-protocol.md`

**Interfaces:**
- Produces firmware message `discovery.announce` protocol version 2.
- Produces controller message `discovery.offer` protocol version 2.
- Produces: `ControllerClient::useDiscoveredController(IPAddress host, uint16_t port)`.
- Preserves: version 1 controller broadcast for old firmware.

- [ ] **Step 1: Write failing Go proof and replay tests**

Test the exact domains and newline payloads from spec section 16. Assert valid announces produce an offer, wrong HMAC and malformed MAC are rejected, repeated device nonce is rejected for 30 seconds, and offer proof includes device nonce, controller nonce, canonical MAC and decimal port.

- [ ] **Step 2: Run and verify Go RED**

Run: `cd controller && go test ./internal/discovery -v`  
Expected: FAIL because version 2 announce/offer types do not exist.

- [ ] **Step 3: Implement Go protocol types and verifier**

Use `crypto/rand`, `crypto/hmac` and existing identity helpers. Bound the replay cache per device and delete entries older than 30 seconds. Build the offer from the UDP packet source address; never accept or echo a controller IP from JSON.

- [ ] **Step 4: Extend the UDP service**

Listen for both version 1 responses and version 2 announces on port 30303. Continue version 1 broadcasts every 5 seconds. For a valid v2 announce, write the signed offer to the exact source IP and port and report diagnostic state `offered_v2`.

- [ ] **Step 5: Write failing firmware protocol tests**

Test parsing a matching offer, rejecting wrong device nonce/device ID/port/proof, and preferring `udp.remoteIP()` over any JSON address. Test that no offer is accepted twice and the saved fallback host is attempted only after 30 seconds without a valid offer.

- [ ] **Step 6: Run firmware RED**

Run: `cd firmware && pio test -e native` where supported, otherwise run the existing PlatformIO test environment selected for protocol tests.  
Expected: compile/test failure because controller-offer parser is missing.

- [ ] **Step 7: Implement ESP32 announce and offer handling**

Generate a fresh 16-byte nonce with ESP32 cryptographic RNG for each announce. Broadcast every 5 seconds while Wi-Fi is connected and WebSocket is not authenticated. Validate offer HMAC and source address, then call `useDiscoveredController(remoteIP, port)` without writing NVS.

- [ ] **Step 8: Implement WebSocket reconnection policy**

When a valid offer changes the target, disconnect the old socket and connect the discovered endpoint. While registered, ignore competing offers. On disconnect resume announces immediately. After 30 seconds without a valid offer, try the saved `controllerHost` while continuing announcements.

- [ ] **Step 9: Verify Go and firmware**

Run: `cd controller && go test ./...`  
Run: `cd firmware && pio run`  
Run the relevant PlatformIO protocol tests.  
Expected: all available checks pass. If PlatformIO is unavailable, record this as a hardware-toolchain blocker and do not claim firmware verification.

- [ ] **Step 10: Flash and network acceptance**

Flash the updated firmware, change the computer from WLAN to the `192.168.137.1` adapter, restart the controller and confirm diagnostic progression `offered_v2 → websocket_connecting → online`. Repeat after changing the computer IP and after restarting the controller. Verify invalid offers never create a controllable device.

- [ ] **Step 11: Record checkpoint**

Record: `authenticated-controller-auto-discovery` with controller tests, firmware build result and on-device evidence.
