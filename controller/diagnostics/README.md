# Controller diagnostics

The Go controller creates one diagnostic session directory every time it starts.

Default location (relative to the controller working directory):

```text
diagnostics/runs/
├─ LATEST.txt
└─ 20260826-141500-12345/
   ├─ runtime.json
   ├─ controller.jsonl
   ├─ controller.txt
   └─ python-vision.txt
```

## Files

- `runtime.json`: session ID, start time, OS/architecture, Go version, PID, command-line arguments and working directory.
- `controller.jsonl`: structured Go lifecycle and HTTP request events. This is the best file for automated timeline analysis.
- `controller.txt`: the normal human-readable Go console log, including existing `log.Printf` calls.
- `python-vision.txt`: stdout/stderr from the Python vision backend, including camera, YOLO, Flask/Waitress and vision runtime messages.
- `LATEST.txt`: the session ID of the newest controller run.

No deployment key, Wi-Fi password or other secret is intentionally written by the diagnostics package.

## Reproducing a problem

1. Start the Go controller.
2. Reproduce one problem only (for example: open camera -> close camera -> open camera again).
3. Stop the controller normally.
4. Open `diagnostics/runs/LATEST.txt`.
5. Upload the matching session directory to GitHub, preferably under `diagnostics/uploaded/<session-id>/`, or attach the four files to the issue/conversation.
6. Record a short note describing what you clicked and approximately when the failure occurred.

For camera restart problems, repeat the cycle several times in the same run so the timestamps can be compared:

```text
open -> preview -> close -> open -> preview -> close -> open
```

The controller JSONL timestamps, HTTP request durations and Python vision output can then be aligned to determine whether delay occurred in the browser/API, Go vision manager, Python service, DirectShow camera open/close, or YOLO initialization.

## Custom log directory

Set `FISH_DIAGNOSTIC_DIR` before starting the controller if you want the logs written somewhere else.

PowerShell example:

```powershell
$env:FISH_DIAGNOSTIC_DIR = "D:\fish-diagnostics"
```
