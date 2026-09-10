"""Per-owner/device vision applications borrowing one capture and detector."""
import io
import json
import threading
import re
from werkzeug.wrappers import Request, Response
from service import VisionService
from web_api import create_app
from webrtc import WebRTCServer
from control import RoboFishComm


class Borrowed:
    def __init__(self, resource, call_lock=None):
        self.resource, self.call_lock = resource, call_lock
    def __getattr__(self, name):
        value = getattr(self.resource, name)
        if not callable(value) or self.call_lock is None:
            return value
        def serialized(*args, **kwargs):
            with self.call_lock:
                return value(*args, **kwargs)
        return serialized
    def start(self): return self
    def close(self, *args, **kwargs): return True
    def release(self): pass
    def submit_frame(self, *args): pass  # only the shared pipeline feeds YOLO


class NoTablet:
    def get_next_command(self): return None
    def get_latest_trajectory(self): return None
    def get_comm_fps(self): return (0.0, 0.0)
    def send(self, *_): pass
    def close(self): pass


class WorkspaceDispatcher:
    PRIVATE_ACTIONS = frozenset({
        'calibration.point', 'calibration.toggle', 'heading.point',
        'heading.select', 'heading.calibrate', 'path.draw', 'path.clear',
        'tracking.start', 'tracking.stop', 'tracking.mode', 'overlay.set',
    })
    def __init__(self, app, shared, application, runner, cameras):
        self.app, self.shared, self.application = app, shared, application
        self.runner, self.cameras = runner, cameras
        self.lock = threading.RLock()
        self.detector_lock = threading.Lock()
        self.contexts = {}
        self.bindings = {}

    def close_all(self):
        for context in self.contexts.values():
            context['service'].stop()
            context['video'].close()
        self.contexts.clear(); self.bindings.clear()

    def context(self, key):
        owner, device, client = key
        root = self.application()
        current = self.shared.current_session()
        if root is None or root.cam is None or current.get('state') not in ('previewing','processing'):
            raise ValueError('共享摄像头未就绪')
        # A browser takeover must retire its old control worker and binding.
        for previous in list(self.contexts):
            if previous[1] == device and previous != key:
                context = self.contexts.pop(previous)
                context['service'].stop(); context['video'].close()
                self.bindings.pop(previous, None)
        if key not in self.contexts:
            video = WebRTCServer().start()
            service = None
            def comm():
                value = RoboFishComm()
                value.workspace_identity = {'ownerId': owner, 'clientId': client}
                return value
            def factory(index, publish, model=None, tracking_mode="yolo"):
                return self.runner(index, service.next_action, publish,
                    frame_sink=video, yolo_model_path=model,
                    tracking_mode=tracking_mode,
                    camera_factory=lambda **_: Borrowed(root.cam),
                    detector_factory=lambda **_: Borrowed(root.detector, self.detector_lock),
                    comm_factory=comm, tablet_factory=lambda **_: NoTablet())
            service = VisionService(runner_factory=factory)
            service.create_session(current['cameraId'],current['cameraIndex'],device)
            child = create_app(service, camera_catalog=self.cameras, webrtc_server=video)
            self.contexts[key] = {'service':service,'video':video,'app':child}
        context = self.contexts[key]
        if current['state'] == 'processing':
            snapshot = context['service'].current_session()
            if snapshot['state'] == 'previewing': context['service'].start_processing(snapshot['sessionId'])
        return context

    def __call__(self, environ, start_response):
        path = environ.get('PATH_INFO','')
        if not path.startswith('/workspaces/'):
            # Camera/crop/recognition changes invalidate dependent workers first.
            method = environ.get('REQUEST_METHOD')
            reset = method not in ('GET','HEAD') and (path == '/crop' or path.endswith('/camera') or method == 'DELETE' or path == '/stop')
            if reset:
                with self.lock: self.close_all()
            return self.app(environ,start_response)
        try:
            _, _, device, suffix = path.split('/',3)
            owner = environ.get('HTTP_X_FISH_WORKSPACE_USER','')
            client = environ.get('HTTP_X_FISH_WORKSPACE_CLIENT','')
            if not owner or not client: return Response('缺少视觉身份',403)(environ,start_response)
            key = (owner,device,client)
            with self.lock:
                context = self.context(key)
                request = Request(environ)
                method = request.method
                allowed = (
                    (method == 'GET' and suffix in ('events', 'sessions/current', 'webrtc/config'))
                    or (method == 'POST' and suffix == 'webrtc/offer')
                    or (method == 'POST' and re.fullmatch(r'sessions/[^/]+/(target|actions)', suffix))
                )
                if not allowed:
                    return Response('该操作属于共享摄像头设置', 403)(environ, start_response)
                if suffix.endswith('/target'):
                    body = request.get_json()
                    if body.get('targetDeviceId') != device: raise ValueError('不能修改其他鱼的绑定')
                    track = body.get('targetTrackId')
                    if track is not None and (isinstance(track,bool) or not isinstance(track,int) or track < 0): raise ValueError('目标编号无效')
                    if track is not None and any(k != key and v == track for k,v in self.bindings.items()):
                        raise ValueError('该识别目标已绑定其他鱼')
                    previous = self.bindings.get(key)
                    self.bindings[key] = track
                    environ['wsgi.input'] = io.BytesIO(request.get_data())
                elif suffix.endswith('/actions'):
                    body = request.get_json(silent=True) or {}
                    if body.get('type') not in self.PRIVATE_ACTIONS:
                        return Response('该操作属于共享摄像头设置', 403)(environ, start_response)
                    environ['wsgi.input'] = io.BytesIO(request.get_data())
                    previous = None
                else: previous = None
                # The browser may still hold the shared session id while the
                # per-device workspace is being created or refreshed. Private
                # workspace actions must always address this context's current
                # session, never a stale id supplied by the client.
                if suffix.endswith('/target') or suffix.endswith('/actions'):
                    child_session_id = context['service'].current_session()['sessionId']
                    suffix_parts = suffix.split('/', 2)
                    suffix = f"sessions/{child_session_id}/{suffix_parts[2]}"
                child_env = dict(environ); child_env['PATH_INFO'] = '/'+suffix
                # Return app_iter without holding the lock: SSE may live indefinitely.
                def started(status, headers, exc_info=None):
                    if suffix.endswith('/target') and not status.startswith('2'):
                        with self.lock: self.bindings[key] = previous
                    return start_response(status,headers,exc_info)
                return context['app'](child_env,started)
        except (ValueError, KeyError, RuntimeError) as error:
            return Response(json.dumps({'message':str(error)}),status=409,content_type='application/json')(environ,start_response)
