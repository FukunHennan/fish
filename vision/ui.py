"""Runtime UI state, mouse actions, toolbar, rendering, and telemetry."""

from __future__ import annotations

from collections import deque
from dataclasses import dataclass
from typing import Any


@dataclass
class VisionRuntimeState:
    trajectory: deque
    drawn_path: dict[str, Any]
    calibration: dict[str, Any]
    pending_actions: deque
    frame: dict[str, Any]
    marker_roi: dict[str, Any]
    heading: dict[str, Any]
    pointer: dict[str, Any]


def create_runtime_state(
    invalid_reference_source: Any,
) -> VisionRuntimeState:
    """Create fresh per-run state; no mutable object is shared across runs."""
    return VisionRuntimeState(
        trajectory=deque(maxlen=150),
        drawn_path={
            "pixels": [],
            "drawing": False,
            "active": False,
            "segment": 0,
            "last_control_t": 0.0,
        },
        calibration={
            "H": None,
            "is_calibrating": False,
            "manual_locked": False,
            "auto_locked": False,
            "auto_stable_count": 0,
            "auto_prev_points": None,
            "pts_raw": [],
            "pts_disp": [],
        },
        pending_actions=deque(),
        frame={
            "latest": None,
            "reference_position": None,
            "reference_source": invalid_reference_source,
            "tail_marker_position": None,
        },
        marker_roi={
            "selecting": False,
            "dragging": False,
            "start": None,
            "end": None,
            "confirmed_bbox": None,
            "confirmed_center": None,
            "confirmed_until": 0.0,
        },
        heading={
            "selecting": False,
            "tail_point": None,
            "head_point": None,
            "unit_vector": None,
            "world_unit_vector": None,
            "control_heading": None,
            "control_heading_source": None,
            "angle_deg": None,
            "confirmed_until": 0.0,
        },
        pointer={"pressed_toolbar_action": None},
    )


from dataclasses import dataclass
from functools import lru_cache
import os
from typing import Dict, List, Optional, Tuple

import cv2
import numpy as np
from PIL import Image, ImageDraw, ImageFont


Color = Tuple[int, int, int]  # OpenCV BGR


class UiPalette:
    PANEL: Color = (28, 32, 38)
    PANEL_ALT: Color = (39, 45, 53)
    BUTTON: Color = (48, 55, 64)
    BUTTON_ACTIVE: Color = (68, 77, 88)
    BORDER: Color = (82, 91, 104)
    TEXT: Color = (242, 244, 247)
    MUTED: Color = (174, 183, 194)
    PRIMARY: Color = (226, 157, 58)
    SUCCESS: Color = (119, 201, 59)
    WARNING: Color = (55, 173, 242)
    DANGER: Color = (92, 92, 235)


FONT_CANDIDATES = (
    os.environ.get("ROBOFISH_UI_FONT", ""),
    "C:/Windows/Fonts/msyh.ttc",
    "C:/Windows/Fonts/simhei.ttf",
    "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
    "/usr/share/fonts/truetype/wqy/wqy-microhei.ttc",
)
BOLD_FONT_CANDIDATES = (
    os.environ.get("ROBOFISH_UI_FONT_BOLD", ""),
    "C:/Windows/Fonts/msyhbd.ttc",
    "C:/Windows/Fonts/simhei.ttf",
    "/usr/share/fonts/opentype/noto/NotoSansCJK-Bold.ttc",
)


def _find_font(candidates: Tuple[str, ...]) -> Optional[str]:
    for candidate in candidates:
        if candidate and os.path.exists(candidate):
            return candidate
    return None


REGULAR_FONT_PATH = _find_font(FONT_CANDIDATES)
BOLD_FONT_PATH = _find_font(BOLD_FONT_CANDIDATES) or REGULAR_FONT_PATH


@lru_cache(maxsize=32)
def _font(size_px: int, bold: bool = False):
    path = BOLD_FONT_PATH if bold else REGULAR_FONT_PATH
    if path:
        return ImageFont.truetype(path, max(8, int(size_px)))
    return ImageFont.load_default()


def measure_unicode_text(text: str, size_px: int, bold: bool = False) -> Tuple[int, int]:
    font = _font(size_px, bold)
    left, top, right, bottom = font.getbbox(str(text))
    return max(1, right - left), max(1, bottom - top)


def draw_unicode_text(
    image: np.ndarray,
    text: str,
    position: Tuple[int, int],
    size_px: int,
    color: Color = UiPalette.TEXT,
    bold: bool = False,
    stroke_width: int = 0,
    stroke_color: Color = (0, 0, 0),
) -> None:
    """Draw Chinese text by converting only its small bounding ROI through PIL."""
    text = str(text)
    if not text:
        return
    font = _font(size_px, bold)
    left, top, right, bottom = font.getbbox(text, stroke_width=stroke_width)
    text_width = max(1, right - left + stroke_width * 2)
    text_height = max(1, bottom - top + stroke_width * 2)
    x, y = int(position[0]), int(position[1])
    x1 = max(0, x)
    y1 = max(0, y)
    x2 = min(image.shape[1], x + text_width)
    y2 = min(image.shape[0], y + text_height)
    if x2 <= x1 or y2 <= y1:
        return

    roi = image[y1:y2, x1:x2]
    pil_image = Image.fromarray(cv2.cvtColor(roi, cv2.COLOR_BGR2RGB))
    painter = ImageDraw.Draw(pil_image)
    draw_x = x - x1 - left + stroke_width
    draw_y = y - y1 - top + stroke_width
    painter.text(
        (draw_x, draw_y),
        text,
        font=font,
        fill=(color[2], color[1], color[0]),
        stroke_width=stroke_width,
        stroke_fill=(stroke_color[2], stroke_color[1], stroke_color[0]),
    )
    image[y1:y2, x1:x2] = cv2.cvtColor(np.asarray(pil_image), cv2.COLOR_RGB2BGR)


def draw_rounded_rectangle(
    image: np.ndarray,
    rectangle: Tuple[int, int, int, int],
    color: Color,
    radius: int = 8,
    thickness: int = -1,
) -> None:
    x1, y1, x2, y2 = [int(value) for value in rectangle]
    radius = int(max(0, min(radius, (x2 - x1) // 2, (y2 - y1) // 2)))
    if radius <= 0:
        cv2.rectangle(image, (x1, y1), (x2, y2), color, thickness)
        return
    if thickness != -1:
        cv2.line(image, (x1 + radius, y1), (x2 - radius, y1), color, thickness)
        cv2.line(image, (x1 + radius, y2), (x2 - radius, y2), color, thickness)
        cv2.line(image, (x1, y1 + radius), (x1, y2 - radius), color, thickness)
        cv2.line(image, (x2, y1 + radius), (x2, y2 - radius), color, thickness)
        cv2.ellipse(image, (x1 + radius, y1 + radius), (radius, radius), 180, 0, 90, color, thickness)
        cv2.ellipse(image, (x2 - radius, y1 + radius), (radius, radius), 270, 0, 90, color, thickness)
        cv2.ellipse(image, (x2 - radius, y2 - radius), (radius, radius), 0, 0, 90, color, thickness)
        cv2.ellipse(image, (x1 + radius, y2 - radius), (radius, radius), 90, 0, 90, color, thickness)
        return
    cv2.rectangle(image, (x1 + radius, y1), (x2 - radius, y2), color, -1)
    cv2.rectangle(image, (x1, y1 + radius), (x2, y2 - radius), color, -1)
    cv2.circle(image, (x1 + radius, y1 + radius), radius, color, -1)
    cv2.circle(image, (x2 - radius, y1 + radius), radius, color, -1)
    cv2.circle(image, (x2 - radius, y2 - radius), radius, color, -1)
    cv2.circle(image, (x1 + radius, y2 - radius), radius, color, -1)


def draw_translucent_panel(
    image: np.ndarray,
    rectangle: Tuple[int, int, int, int],
    color: Color = UiPalette.PANEL,
    alpha: float = 0.84,
    radius: int = 8,
) -> None:
    overlay = image.copy()
    draw_rounded_rectangle(overlay, rectangle, color, radius=radius, thickness=-1)
    cv2.addWeighted(overlay, alpha, image, 1.0 - alpha, 0.0, image)


def fit_preview_window_size(
    frame_width: int,
    frame_height: int,
    screen_width: int,
    screen_height: int,
) -> Tuple[int, int]:
    """Return a large aspect-preserving preview size that still fits the screen."""
    frame_width = max(1, int(frame_width))
    frame_height = max(1, int(frame_height))
    usable_width = max(frame_width, int(screen_width * 0.90))
    usable_height = max(frame_height, int(screen_height * 0.90))
    scale = min(usable_width / frame_width, usable_height / frame_height)
    return int(round(frame_width * scale)), int(round(frame_height * scale))


def enable_windows_dpi_awareness() -> bool:
    """让 Windows 鼠标坐标与 OpenCV 窗口矩形使用同一像素尺度。"""
    if os.name != "nt":
        return False
    try:
        import ctypes

        user32 = ctypes.windll.user32
        try:
            # PER_MONITOR_AWARE_V2; 必须在创建 HighGUI 窗口前调用。
            if user32.SetProcessDpiAwarenessContext(ctypes.c_void_p(-4)):
                return True
        except Exception:
            pass
        try:
            return bool(user32.SetProcessDPIAware())
        except Exception:
            return False
    except Exception:
        return False


def map_screen_point_to_frame(
    screen_x: int,
    screen_y: int,
    image_rectangle: Tuple[int, int, int, int],
    frame_width: int,
    frame_height: int,
) -> Optional[Tuple[int, int]]:
    """Map an absolute Windows cursor position into the displayed camera frame."""
    image_x, image_y, image_width, image_height = image_rectangle
    if image_width <= 0 or image_height <= 0:
        return None
    relative_x = int(screen_x) - int(image_x)
    relative_y = int(screen_y) - int(image_y)
    if not (0 <= relative_x < image_width and 0 <= relative_y < image_height):
        return None
    frame_x = int(relative_x * frame_width / image_width)
    frame_y = int(relative_y * frame_height / image_height)
    return (
        int(np.clip(frame_x, 0, frame_width - 1)),
        int(np.clip(frame_y, 0, frame_height - 1)),
    )


def map_client_point_to_frame(
    client_x: int,
    client_y: int,
    client_width: int,
    client_height: int,
    frame_width: int,
    frame_height: int,
) -> Optional[Tuple[int, int]]:
    """把 Win32 客户区坐标映射到画布，同时处理等比例黑边。"""
    client_width = int(client_width)
    client_height = int(client_height)
    frame_width = max(1, int(frame_width))
    frame_height = max(1, int(frame_height))
    if client_width <= 0 or client_height <= 0:
        return None

    scale = min(client_width / frame_width, client_height / frame_height)
    image_width = frame_width * scale
    image_height = frame_height * scale
    image_x = (client_width - image_width) * 0.5
    image_y = (client_height - image_height) * 0.5
    relative_x = float(client_x) - image_x
    relative_y = float(client_y) - image_y
    if not (0.0 <= relative_x < image_width and 0.0 <= relative_y < image_height):
        return None

    return (
        int(np.clip(relative_x * frame_width / image_width, 0, frame_width - 1)),
        int(np.clip(relative_y * frame_height / image_height, 0, frame_height - 1)),
    )


class WindowsPointerPoller:
    """Win32 pointer fallback for HighGUI builds that drop mouse callbacks."""

    VK_LBUTTON = 0x01
    VK_RBUTTON = 0x02

    def __init__(self, window_name: str, frame_width: int, frame_height: int):
        self.window_name = str(window_name)
        self.frame_width = max(1, int(frame_width))
        self.frame_height = max(1, int(frame_height))
        self.available = False
        self._button_down = {self.VK_LBUTTON: False, self.VK_RBUTTON: False}
        self._started_inside = {self.VK_LBUTTON: False, self.VK_RBUTTON: False}
        self._last_point: Optional[Tuple[int, int]] = None
        self.last_screen_point: Optional[Tuple[int, int]] = None
        self.last_image_rectangle: Optional[Tuple[int, int, int, int]] = None
        self.last_mapping_source = "NONE"
        self._user32 = None
        self._point_type = None
        self._rect_type = None
        self._ctypes = None
        if os.name != "nt":
            return
        try:
            import ctypes
            from ctypes import wintypes

            self._user32 = ctypes.windll.user32
            self._point_type = wintypes.POINT
            self._rect_type = wintypes.RECT
            self._ctypes = ctypes
            self._user32.FindWindowW.argtypes = [wintypes.LPCWSTR, wintypes.LPCWSTR]
            self._user32.FindWindowW.restype = wintypes.HWND
            self._user32.WindowFromPoint.argtypes = [wintypes.POINT]
            self._user32.WindowFromPoint.restype = wintypes.HWND
            self._user32.GetAncestor.argtypes = [wintypes.HWND, wintypes.UINT]
            self._user32.GetAncestor.restype = wintypes.HWND
            self._user32.GetClientRect.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.RECT)]
            self._user32.GetClientRect.restype = wintypes.BOOL
            self._user32.ScreenToClient.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.POINT)]
            self._user32.ScreenToClient.restype = wintypes.BOOL
            self._user32.ClientToScreen.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.POINT)]
            self._user32.ClientToScreen.restype = wintypes.BOOL
            self._user32.ShowWindow.argtypes = [wintypes.HWND, ctypes.c_int]
            self._user32.ShowWindow.restype = wintypes.BOOL
            self.available = True
        except Exception:
            self.available = False

    def maximize_window(self) -> bool:
        """最大化 OpenCV 顶层窗口，保留标题栏和正确画面比例。"""
        if not self.available or self._user32 is None:
            return False
        try:
            top_window = self._user32.FindWindowW(None, self.window_name)
            if not top_window:
                return False
            self._user32.ShowWindow(top_window, 3)  # SW_MAXIMIZE
            return True
        except Exception:
            return False

    def _cursor_point(self) -> Optional[Tuple[int, int]]:
        if (
            not self.available or self._user32 is None
            or self._point_type is None or self._ctypes is None
        ):
            return None
        point = self._point_type()
        if not self._user32.GetCursorPos(self._ctypes.byref(point)):
            return None
        self.last_screen_point = (int(point.x), int(point.y))

        # OpenCV Win32UI 的顶层窗口内还有一个真正绘制图像的子窗口。
        # 直接使用鼠标下方的原生 HWND，可避免 OpenCV 返回的矩形
        # 与 Windows DPI 虚拟坐标不在同一尺度。
        try:
            top_window = self._user32.FindWindowW(None, self.window_name)
            canvas_window = self._user32.WindowFromPoint(point)
            if top_window and canvas_window:
                root_window = self._user32.GetAncestor(canvas_window, 2)  # GA_ROOT
                if root_window == top_window:
                    local_point = self._point_type(point.x, point.y)
                    client_rect = self._rect_type()
                    if (
                        self._user32.ScreenToClient(
                            canvas_window, self._ctypes.byref(local_point)
                        )
                        and self._user32.GetClientRect(
                            canvas_window, self._ctypes.byref(client_rect)
                        )
                    ):
                        client_width = int(client_rect.right - client_rect.left)
                        client_height = int(client_rect.bottom - client_rect.top)
                        mapped = map_client_point_to_frame(
                            local_point.x, local_point.y,
                            client_width, client_height,
                            self.frame_width, self.frame_height,
                        )
                        if mapped is not None:
                            client_origin = self._point_type(0, 0)
                            self._user32.ClientToScreen(
                                canvas_window, self._ctypes.byref(client_origin)
                            )
                            scale = min(
                                client_width / self.frame_width,
                                client_height / self.frame_height,
                            )
                            image_width = int(round(self.frame_width * scale))
                            image_height = int(round(self.frame_height * scale))
                            image_x = int(round(
                                client_origin.x + (client_width - image_width) * 0.5
                            ))
                            image_y = int(round(
                                client_origin.y + (client_height - image_height) * 0.5
                            ))
                            self.last_image_rectangle = (
                                image_x, image_y, image_width, image_height
                            )
                            self.last_mapping_source = "WIN32_CANVAS"
                            return mapped
        except Exception:
            pass

        # 非 Win32UI 或原生窗口未就绪时才使用 OpenCV 备用路径。
        try:
            image_rectangle = cv2.getWindowImageRect(self.window_name)
        except (cv2.error, AttributeError):
            return None
        self.last_image_rectangle = tuple(int(value) for value in image_rectangle)
        self.last_mapping_source = "OPENCV_FALLBACK"
        return map_screen_point_to_frame(
            point.x, point.y, image_rectangle,
            self.frame_width, self.frame_height,
        )

    def poll(self) -> List[Tuple[int, int, int, int]]:
        """Return pending `(event, x, y, flags)` transitions for this frame."""
        if not self.available or self._user32 is None:
            return []
        current_point = self._cursor_point()
        events: List[Tuple[int, int, int, int]] = []
        button_specs = (
            (self.VK_LBUTTON, cv2.EVENT_LBUTTONDOWN, cv2.EVENT_LBUTTONUP,
             cv2.EVENT_FLAG_LBUTTON),
            (self.VK_RBUTTON, cv2.EVENT_RBUTTONDOWN, cv2.EVENT_RBUTTONUP,
             cv2.EVENT_FLAG_RBUTTON),
        )
        for virtual_key, down_event, up_event, flag in button_specs:
            is_down = bool(self._user32.GetAsyncKeyState(virtual_key) & 0x8000)
            was_down = self._button_down[virtual_key]
            if is_down and not was_down:
                self._started_inside[virtual_key] = current_point is not None
                if current_point is not None:
                    events.append((down_event, current_point[0], current_point[1], flag))
            elif not is_down and was_down:
                if self._started_inside[virtual_key]:
                    release_point = current_point or self._last_point
                    if release_point is not None:
                        events.append((up_event, release_point[0], release_point[1], 0))
                self._started_inside[virtual_key] = False
            self._button_down[virtual_key] = is_down

        if self._button_down[self.VK_LBUTTON] and self._started_inside[self.VK_LBUTTON]:
            if current_point is not None and current_point != self._last_point:
                events.append((
                    cv2.EVENT_MOUSEMOVE,
                    current_point[0], current_point[1],
                    cv2.EVENT_FLAG_LBUTTON,
                ))
        if current_point is not None:
            self._last_point = current_point
        return events


@dataclass(frozen=True)
class ToolbarButton:
    action: str
    label: str
    role: str = "normal"


class VisionToolbar:
    HEIGHT = 76
    GAP = 5
    ROWS: Tuple[Tuple[ToolbarButton, ...], ...] = (
        (
            ToolbarButton("START", "启动", "primary"),
            ToolbarButton("STOP", "停止", "danger"),
            ToolbarButton("CLEAR_PATH", "清除轨迹"),
            ToolbarButton("MARKER_ROI", "鱼尾标定", "primary"),
            ToolbarButton("HEAD_DIRECTION", "鱼头方向", "primary"),
            ToolbarButton("POOL_CALIB", "场地标定", "primary"),
        ),
        (
            ToolbarButton("TURN_CALIB", "转圈测量", "primary"),
            ToolbarButton("RECORD", "录像"),
            ToolbarButton("SNAPSHOT", "截图"),
            ToolbarButton("CLAHE", "画面增强"),
            ToolbarButton("EXP_DOWN", "曝光－"),
            ToolbarButton("EXP_UP", "曝光＋"),
            ToolbarButton("EXIT", "退出", "danger"),
        ),
    )

    def __init__(self):
        self._rectangles: Dict[str, Tuple[int, int, int, int]] = {}

    @property
    def height(self) -> int:
        return self.HEIGHT

    def layout(self, frame_width: int, frame_height: int) -> Dict[str, Tuple[int, int, int, int]]:
        panel_top = max(0, frame_height - self.HEIGHT)
        row_height = max(24, (self.HEIGHT - self.GAP * 3) // 2)
        rectangles: Dict[str, Tuple[int, int, int, int]] = {}
        for row_index, buttons in enumerate(self.ROWS):
            y1 = panel_top + self.GAP + row_index * (row_height + self.GAP)
            y2 = min(frame_height - self.GAP, y1 + row_height)
            available = frame_width - self.GAP * (len(buttons) + 1)
            button_width = max(1, available // len(buttons))
            for column, button in enumerate(buttons):
                x1 = self.GAP + column * (button_width + self.GAP)
                x2 = frame_width - self.GAP if column == len(buttons) - 1 else x1 + button_width
                rectangles[button.action] = (x1, y1, x2, y2)
        self._rectangles = rectangles
        return dict(rectangles)

    def hit_test(
        self, x: int, y: int, frame_width: int, frame_height: int
    ) -> Optional[str]:
        rectangles = self.layout(frame_width, frame_height)
        for action, (x1, y1, x2, y2) in rectangles.items():
            if x1 <= x < x2 and y1 <= y < y2:
                return action
        return None

    def contains(self, x: int, y: int, frame_height: int) -> bool:
        return 0 <= x and y >= frame_height - self.HEIGHT

    @staticmethod
    def _role_color(role: str) -> Color:
        if role == "danger":
            return UiPalette.DANGER
        if role == "primary":
            return UiPalette.PRIMARY
        return UiPalette.BORDER

    def draw(self, image: np.ndarray, active: Optional[Dict[str, bool]] = None) -> None:
        active = active or {}
        height, width = image.shape[:2]
        panel_top = max(0, height - self.HEIGHT)
        overlay = image.copy()
        cv2.rectangle(overlay, (0, panel_top), (width, height), UiPalette.PANEL, -1)
        cv2.addWeighted(overlay, 0.92, image, 0.08, 0.0, image)
        rectangles = self.layout(width, height)
        by_action = {button.action: button for row in self.ROWS for button in row}

        for action, rectangle in rectangles.items():
            x1, y1, x2, y2 = rectangle
            button = by_action[action]
            accent = self._role_color(button.role)
            fill = UiPalette.BUTTON_ACTIVE if active.get(action, False) else UiPalette.BUTTON
            if active.get(action, False):
                fill = tuple(int(0.65 * fill[i] + 0.35 * accent[i]) for i in range(3))
            draw_rounded_rectangle(image, rectangle, fill, radius=5, thickness=-1)
            draw_rounded_rectangle(image, rectangle, accent, radius=5, thickness=1)
            if active.get(action, False):
                cv2.rectangle(image, (x1 + 5, y2 - 3), (x2 - 5, y2 - 2), accent, -1)

            text_width, text_height = measure_unicode_text(button.label, 14, bold=True)
            text_x = x1 + max(2, (x2 - x1 - text_width) // 2)
            text_y = y1 + max(2, (y2 - y1 - text_height) // 2 - 1)
            draw_unicode_text(
                image, button.label, (text_x, text_y), 14,
                UiPalette.TEXT, bold=True
            )


class VisionHud:
    SOURCE_NAMES = {
        "RIGID_BODY": "白色刚性鱼身",
        "MARKER": "鱼尾定位",
        "PREDICTED": "短时预测",
        "ESTIMATED_FALLBACK": "识别框降级",
        "INVALID": "位置无效",
    }
    STATUS_NAMES = {
        "READY": "待命",
        "STOPPED": "已停止",
        "EMERGENCY STOP": "紧急停止",
        "PROP TRACKING": "轨迹跟随",
        "HYBRID TRACKING": "混合轨迹跟随",
        "HYBRID BRAKING": "混合柔性制动",
        "TARGET LOST": "目标丢失",
        "ARRIVED": "已到终点",
        "UNCALIBRATED": "场地未标定",
        "CALIBRATING": "场地标定中",
        "SELECT MARKER ROI": "色标框选中",
        "MARKER READY": "色标已就绪",
        "MARKER ROI RETRY": "色标需重选",
        "SELECT HEAD DIRECTION": "鱼头方向标定",
        "HEAD DIRECTION READY": "初始方向已标定",
        "TURN CALIBRATING": "转圈测量中",
        "TURN CALIBRATED": "转圈测量完成",
        "PATH CLEARED": "轨迹已清除",
        "CAMERA PAUSED": "相机等待中",
    }
    GATE_NAMES = {
        "MARKER_NOT_CALIBRATED": "鱼尾未标定",
        "YOLO_NOT_CONFIRMED": "未确认机器鱼",
        "NO_MARKER_CONTOUR": "未找到橙色鱼尾",
        "AREA_GATE": "面积异常",
        "CIRCULARITY_GATE": "轮廓形状异常",
        "EXTENT_GATE": "轮廓填充异常",
        "ASPECT_GATE": "长宽比异常",
        "COLOR_GATE": "颜色质量不足",
        "BOUNDARY_CROP_GATE": "色标被边界裁切",
        "POSITION_JUMP_GATE": "位置突变",
        "QUALITY_GATE": "综合质量不足",
        "INVALID_FRAME": "画面无效",
        "BODY_TOO_SMALL_GATE": "白色候选面积过小",
        "NO_RIGID_BODY_CONTOUR": "未找到白色刚性鱼身",
        "BODY_MARKER_DISTANCE_GATE": "白色候选不在鱼身位置",
        "BODY_POSITION_JUMP_GATE": "白色鱼身位置突变",
        "BODY_GLARE_SHAPE_GATE": "白色候选像圆形反光",
        "BODY_GLARE_EXPOSURE_GATE": "白色候选过曝",
    }

    @staticmethod
    def _source_color(source: str) -> Color:
        if source in ("RIGID_BODY", "MARKER"):
            return UiPalette.SUCCESS
        if source == "PREDICTED":
            return UiPalette.WARNING
        if source == "ESTIMATED_FALLBACK":
            return UiPalette.WARNING
        return UiPalette.DANGER

    def draw(
        self,
        image: np.ndarray,
        *,
        source: str,
        status: str,
        quality: float,
        pwm_ready: bool,
        position: Optional[Tuple[float, float]],
        speed: Optional[float],
        direction_deg: Optional[float],
        gate_reasons,
        loop_fps: float,
        camera_fps: float,
        yolo_fps: float,
        exposure: int,
        tablet_tx_hz: float,
        tablet_rx_hz: float,
        mcu_hz: float,
        tracking_error: Optional[Dict[str, float]] = None,
        prompt: Optional[str] = None,
    ) -> None:
        height, width = image.shape[:2]
        left_bottom = 108 if source == "INVALID" and gate_reasons else 88
        left_rect = (8, 8, min(314, width - 8), left_bottom)
        right_rect = (max(322, width - 206), 8, width - 8, 67)
        draw_translucent_panel(image, left_rect, alpha=0.35, radius=6)
        draw_translucent_panel(image, right_rect, alpha=0.35, radius=6)

        source_name = self.SOURCE_NAMES.get(source, source)
        status_name = self.STATUS_NAMES.get(status, status)
        source_color = self._source_color(source)
        cv2.circle(image, (20, 21), 4, source_color, -1, cv2.LINE_AA)
        draw_unicode_text(image, f"{status_name} · {source_name}", (30, 12), 14, UiPalette.TEXT, bold=True)

        if position is None:
            position_text = "位置：无效"
        else:
            position_text = f"位置：X {position[0]:.2f} m　Y {position[1]:.2f} m"
        draw_unicode_text(image, position_text, (16, 35), 11, UiPalette.TEXT)

        if speed is None or direction_deg is None:
            motion_text = "速度：无效　运动方向：无效"
        else:
            motion_text = f"速度：{speed:.2f} m/s　运动方向：{direction_deg:.1f}°"
        draw_unicode_text(image, motion_text, (16, 52), 11, UiPalette.TEXT)

        quality_text = f"跟踪质量：{quality * 100:.0f}%　精标定：{'可用' if pwm_ready else '不可用'}"
        draw_unicode_text(
            image, quality_text, (16, 69), 11,
            UiPalette.SUCCESS if pwm_ready else UiPalette.WARNING
        )

        draw_unicode_text(image, "运行状态", (right_rect[0] + 9, 12), 12, UiPalette.TEXT, bold=True)
        draw_unicode_text(
            image,
            f"循环 {loop_fps:.1f}　相机 {camera_fps:.1f}　识别 {yolo_fps:.1f}",
            (right_rect[0] + 9, 31), 10, UiPalette.MUTED
        )
        draw_unicode_text(
            image,
            f"平板 {tablet_tx_hz:.1f}/{tablet_rx_hz:.1f}　设备 {mcu_hz:.1f}　曝光 {exposure}",
            (right_rect[0] + 9, 47), 10, UiPalette.MUTED
        )

        if source == "INVALID" and gate_reasons:
            gate_name = self.GATE_NAMES.get(gate_reasons[0], gate_reasons[0])
            draw_unicode_text(image, f"原因：{gate_name}", (16, 88), 11, UiPalette.DANGER, bold=True)

        if tracking_error is not None:
            panel_bottom = height - VisionToolbar.HEIGHT - 7
            panel_top = panel_bottom - 46
            panel_right = min(width - 8, 455)
            draw_translucent_panel(image, (8, panel_top, panel_right, panel_bottom), alpha=0.88)
            heading_error = tracking_error.get('heading_error_deg')
            if heading_error is None:
                detail_text = (
                    f"轨迹偏差：{tracking_error.get('cross_m', 0.0):+.3f} m　"
                    f"剩余：{tracking_error.get('dist_m', 0.0):.3f} m　"
                    f"段号：{int(tracking_error.get('seg_index', 0))}"
                )
            else:
                detail_text = (
                    f"鱼体左右：{tracking_error.get('x_error_m', 0.0):+.3f} m　"
                    f"航向误差：{float(heading_error):+.1f}°　"
                    f"剩余：{tracking_error.get('dist_m', 0.0):.3f} m"
                )
            draw_unicode_text(
                image,
                detail_text,
                (18, panel_top + 13), 14, UiPalette.TEXT, bold=True
            )

        if prompt:
            prompt_width = min(width - 32, 520)
            prompt_left = (width - prompt_width) // 2
            prompt_rect = (prompt_left, 112, prompt_left + prompt_width, 147)
            draw_translucent_panel(image, prompt_rect, UiPalette.PANEL_ALT, 0.42, radius=6)
            text_width, _ = measure_unicode_text(prompt, 14, bold=True)
            text_x = prompt_left + max(10, (prompt_width - text_width) // 2)
            draw_unicode_text(image, prompt, (text_x, 122), 14, UiPalette.WARNING, bold=True)


import cv2
import numpy as np


class VisionMouseController:
    """Translate HighGUI mouse events into application actions.

    State dictionaries are shared with the application on purpose: this keeps
    event handling isolated without duplicating ownership of live UI state.
    """

    def __init__(
        self,
        *,
        frame_width,
        frame_height,
        toolbar,
        pending_actions,
        pointer_state,
        marker_roi_state,
        heading_state,
        calibration_state,
        drawn_path_state,
    ):
        self.frame_width = frame_width
        self.frame_height = frame_height
        self.toolbar = toolbar
        self.pending_actions = pending_actions
        self.pointer_state = pointer_state
        self.marker_roi_state = marker_roi_state
        self.heading_state = heading_state
        self.calibration_state = calibration_state
        self.drawn_path_state = drawn_path_state

    def __call__(self, event, x, y, flags, param):
        del flags, param
        rx = int(np.clip(x, 0, self.frame_width - 1))
        ry = int(np.clip(y, 0, self.frame_height - 1))

        if event in (cv2.EVENT_LBUTTONDOWN, cv2.EVENT_LBUTTONUP):
            toolbar_action = self.toolbar.hit_test(
                rx, ry, self.frame_width, self.frame_height
            )
            if toolbar_action is not None:
                if event == cv2.EVENT_LBUTTONDOWN:
                    self.pending_actions.append(toolbar_action)
                    self.pointer_state["pressed_toolbar_action"] = toolbar_action
                elif self.pointer_state["pressed_toolbar_action"] != toolbar_action:
                    self.pending_actions.append(toolbar_action)
                self.pointer_state["pressed_toolbar_action"] = (
                    toolbar_action if event == cv2.EVENT_LBUTTONDOWN else None
                )
                self.drawn_path_state["drawing"] = False
                self.marker_roi_state["dragging"] = False
                return
            if self.toolbar.contains(rx, ry, self.frame_height):
                return

        if self.marker_roi_state["selecting"]:
            canvas_bottom = max(0, self.frame_height - self.toolbar.height - 1)
            marker_y = int(np.clip(ry, 0, canvas_bottom))
            if event == cv2.EVENT_LBUTTONDOWN:
                self.marker_roi_state["start"] = (rx, marker_y)
                self.marker_roi_state["end"] = (rx, marker_y)
                self.marker_roi_state["dragging"] = True
            elif event == cv2.EVENT_MOUSEMOVE and self.marker_roi_state["dragging"]:
                self.marker_roi_state["end"] = (rx, marker_y)
            elif event == cv2.EVENT_LBUTTONUP and self.marker_roi_state["dragging"]:
                self.marker_roi_state["end"] = (rx, marker_y)
                self.marker_roi_state["dragging"] = False
                start = self.marker_roi_state["start"]
                end = self.marker_roi_state["end"]
                if start is not None and end is not None:
                    self.pending_actions.append((
                        "APPLY_MARKER_ROI",
                        (start[0], start[1], end[0], end[1]),
                    ))
            elif event == cv2.EVENT_RBUTTONDOWN:
                self.marker_roi_state["selecting"] = False
                self.marker_roi_state["dragging"] = False
                self.marker_roi_state["start"] = None
                self.marker_roi_state["end"] = None
                print("已取消色标框选。")
            return

        if self.heading_state["selecting"]:
            if event == cv2.EVENT_LBUTTONDOWN:
                self.pending_actions.append(("APPLY_HEAD_DIRECTION", (rx, ry)))
            elif event == cv2.EVENT_RBUTTONDOWN:
                self.heading_state["selecting"] = False
                print("已取消鱼头方向标定，原有初始方向保持不变。")
            return

        if event == cv2.EVENT_LBUTTONDOWN and self.calibration_state["is_calibrating"]:
            self.pending_actions.append(("APPLY_POOL_POINT", (rx, ry)))
        elif not self.calibration_state["is_calibrating"]:
            if event == cv2.EVENT_LBUTTONDOWN:
                if self.drawn_path_state["active"]:
                    self.pending_actions.append("PATH_EDIT_STARTED")
                self.drawn_path_state["pixels"] = [(rx, ry)]
                self.drawn_path_state["drawing"] = True
                self.drawn_path_state["active"] = False
                self.drawn_path_state["segment"] = 0
            elif event == cv2.EVENT_MOUSEMOVE and self.drawn_path_state["drawing"]:
                if self.toolbar.contains(rx, ry, self.frame_height):
                    return
                points = self.drawn_path_state["pixels"]
                if not points or (
                    (rx - points[-1][0]) ** 2 + (ry - points[-1][1]) ** 2 >= 5 ** 2
                ):
                    points.append((rx, ry))
            elif event == cv2.EVENT_LBUTTONUP and self.drawn_path_state["drawing"]:
                self.drawn_path_state["drawing"] = False
                if len(self.drawn_path_state["pixels"]) < 2:
                    self.drawn_path_state["pixels"].clear()
            elif event == cv2.EVENT_RBUTTONDOWN:
                self.drawn_path_state["pixels"].clear()
                self.drawn_path_state["drawing"] = False
                self.drawn_path_state["active"] = False
                self.drawn_path_state["segment"] = 0
                self.pending_actions.append("CLEAR_PATH")


import cv2
import numpy as np

from config import CAMERA_LATENCY_S
def _outlined_text(image, text, position, scale=0.7, color=(0, 165, 255)):
    cv2.putText(
        image, text, position, cv2.FONT_HERSHEY_SIMPLEX, scale,
        (0, 0, 0), 5, cv2.LINE_AA,
    )
    cv2.putText(
        image, text, position, cv2.FONT_HERSHEY_SIMPLEX, scale,
        color, 2, cv2.LINE_AA,
    )


def _json_safe(value):
    if isinstance(value, np.ndarray):
        return [_json_safe(item) for item in value.tolist()]
    if isinstance(value, np.generic):
        return value.item()
    if isinstance(value, dict):
        return {key: _json_safe(item) for key, item in value.items()}
    if isinstance(value, (tuple, list)):
        return [_json_safe(item) for item in value]
    return value


class VisionPresentation:
    def __init__(self, toolbar, hud, trajectory, web_clean=False):
        self.toolbar = toolbar
        self.hud = hud
        self.trajectory = trajectory
        self.web_clean = web_clean

    def render(
        self,
        result,
        *,
        calibration,
        marker_roi,
        heading,
        drawn_path,
        decision,
        control_active,
        turn_session,
        status,
        recording,
        camera_fps,
        loop_fps,
        exposure,
        tablet_rates,
        mcu_hz,
        clahe_enabled,
    ):
        image = result.frame.copy()
        self._draw_selection(image, marker_roi, heading, result)
        self._draw_paths(image, drawn_path)
        self._draw_calibration(image, calibration, result.corner_pixels)
        self._draw_detection(image, result)
        self._draw_reference(image, result)
        self._draw_guidance(image, result, calibration.get("H"), decision)

        prompt = self._prompt(
            result, calibration, marker_roi, heading, turn_session
        )
        guidance = decision.guidance if decision is not None else None
        tx_hz, rx_hz = tablet_rates
        if not self.web_clean:
            self.hud.draw(
            image,
            source=result.reference.source,
            status=status,
            quality=result.reference.quality,
            pwm_ready=result.reference.usable_for_pwm_speed,
            position=result.current_position,
            speed=result.speed,
            direction_deg=result.direction_deg,
            gate_reasons=result.reference.gate_reasons,
            loop_fps=loop_fps,
            camera_fps=camera_fps,
            yolo_fps=result.yolo_fps,
            exposure=exposure,
            tablet_tx_hz=tx_hz,
            tablet_rx_hz=rx_hz,
            mcu_hz=mcu_hz,
            tracking_error=guidance,
            prompt=prompt,
        )
        if recording and not self.web_clean:
            cv2.circle(
                image, (image.shape[1] - 22, 107), 5, UiPalette.DANGER, -1
            )
            draw_unicode_text(
                image, "录像中", (image.shape[1] - 78, 98),
                13, UiPalette.DANGER, bold=True,
            )
        if not self.web_clean:
            self.toolbar.draw(image, active={
                "START": bool(control_active),
                "STOP": status in ("STOPPED", "EMERGENCY STOP"),
                "MARKER_ROI": marker_roi["selecting"],
                "HEAD_DIRECTION": heading["selecting"],
                "POOL_CALIB": calibration["is_calibrating"],
                "TURN_CALIB": turn_session.active,
                "RECORD": recording,
                "CLAHE": clahe_enabled,
            })
        return image

    def _draw_selection(self, image, marker_roi, heading, result):
        if marker_roi["selecting"] and marker_roi["start"] is not None:
            end = marker_roi["end"] or marker_roi["start"]
            cv2.rectangle(image, marker_roi["start"], end, (0, 165, 255), 2)
        if (
            marker_roi["confirmed_bbox"] is not None
            and result.frame_time <= marker_roi["confirmed_until"]
        ):
            x1, y1, x2, y2 = marker_roi["confirmed_bbox"]
            cx, cy = marker_roi["confirmed_center"]
            cv2.rectangle(image, (x1, y1), (x2, y2), UiPalette.SUCCESS, 2)
            cv2.drawMarker(
                image, (int(round(cx)), int(round(cy))), UiPalette.SUCCESS,
                cv2.MARKER_CROSS, 14, 2, cv2.LINE_AA,
            )
        tail = result.reference.metrics.get("tail_marker_position")
        if heading["selecting"] and tail is not None:
            tail_point = tuple(int(round(value)) for value in tail)
            cv2.drawMarker(
                image, tail_point, UiPalette.PRIMARY,
                cv2.MARKER_CROSS, 18, 2, cv2.LINE_AA,
            )
            draw_unicode_text(
                image, "鱼尾已获取，请点击鱼头中心",
                (min(image.shape[1] - 220, tail_point[0] + 12),
                 max(3, tail_point[1] - 24)),
                13, UiPalette.PRIMARY, bold=True,
            )
        if heading["tail_point"] is not None and heading["head_point"] is not None:
            if result.frame_time <= heading["confirmed_until"]:
                tail_point = tuple(int(round(v)) for v in heading["tail_point"])
                head_point = tuple(int(round(v)) for v in heading["head_point"])
                cv2.arrowedLine(
                    image, tail_point, head_point, UiPalette.PRIMARY,
                    3, cv2.LINE_AA, tipLength=0.18,
                )

    def _draw_paths(self, image, drawn_path):
        pixels = drawn_path["pixels"]
        if len(pixels) > 1:
            path_pixels = np.asarray(pixels, dtype=np.int32).reshape((-1, 1, 2))
            cv2.polylines(
                image, [path_pixels], False, (255, 0, 255), 3, cv2.LINE_AA
            )
            cv2.circle(image, tuple(pixels[-1]), 7, (0, 255, 0), -1)
        if len(self.trajectory) > 1:
            points = np.asarray(self.trajectory, np.int32).reshape((-1, 1, 2))
            cv2.polylines(
                image, [points], False, (0, 255, 255), 2, cv2.LINE_AA
            )

    def _draw_calibration(self, image, calibration, auto_corners):
        for marker_id, point in auto_corners.items():
            centre = tuple(int(round(value)) for value in point)
            cv2.circle(image, centre, 6, (0, 165, 255), 2)
            _outlined_text(image, str(marker_id), (centre[0] + 8, centre[1] - 8))
        for index, point in enumerate(calibration["pts_raw"]):
            centre = (int(point[0]), int(point[1]))
            cv2.circle(image, centre, 7, (0, 165, 255), -1)
            _outlined_text(image, str(index + 1), (centre[0] + 10, centre[1] - 10))

    def _draw_detection(self, image, result):
        bbox = result.yolo_bbox
        if bbox is None:
            return
        x1, y1, x2, y2 = [int(value) for value in bbox]
        cv2.rectangle(image, (x1, y1), (x2, y2), UiPalette.PRIMARY, 1)
        label = (
            f"机器鱼 #{result.track_id if result.track_id is not None else '-'}　"
            f"{result.yolo_confidence * 100:.0f}%"
        )
        draw_unicode_text(
            image, label, (x1, max(3, y1 - 20)),
            13, UiPalette.PRIMARY, bold=True, stroke_width=1,
        )

    def _draw_reference(self, image, result):
        if result.display_pixel is None:
            return
        cx, cy = result.display_pixel
        colours = {
            "RIGID_BODY": UiPalette.SUCCESS,
            "MARKER": UiPalette.SUCCESS,
            "PREDICTED": UiPalette.WARNING,
            "ESTIMATED_FALLBACK": UiPalette.WARNING,
        }
        colour = colours.get(result.reference.source, UiPalette.DANGER)
        cv2.rectangle(image, (cx - 15, cy - 15), (cx + 15, cy + 15), colour, 2)
        cv2.circle(image, (cx, cy), 4, colour, -1)
        text = (
            f"{self.hud.SOURCE_NAMES.get(result.reference.source, result.reference.source)}　"
            f"质量 {result.reference.quality * 100:.0f}%"
        )
        draw_unicode_text(
            image, text, (cx + 20, max(3, cy - 24)),
            13, colour, bold=True, stroke_width=1,
        )
        if not self.trajectory:
            self.trajectory.append((cx, cy))
        else:
            last = self.trajectory[-1]
            if (cx - last[0]) ** 2 + (cy - last[1]) ** 2 >= 9.0:
                self.trajectory.append((cx, cy))

    def _draw_guidance(self, image, result, homography, decision):
        guidance = None if decision is None else decision.guidance
        if guidance is None or homography is None or result.pixel is None:
            return
        try:
            inverse = np.linalg.inv(homography)
            position = np.asarray(result.control_position, dtype=np.float32)
            heading_tip = position + np.asarray(guidance["heading"], np.float32) * 0.18
            world = np.float32([[
                guidance["lookahead_point"],
                guidance["closest_point"],
                heading_tip,
            ]])
            pixels = cv2.perspectiveTransform(world, inverse)[0]
            lookahead, closest, heading = [
                tuple(int(round(value)) for value in point) for point in pixels
            ]
            tail = tuple(int(round(value)) for value in result.pixel)
            cv2.line(image, tail, lookahead, (255, 255, 0), 2, cv2.LINE_AA)
            cv2.circle(image, lookahead, 7, (255, 255, 0), 2)
            cv2.circle(image, closest, 4, (255, 0, 255), -1)
            cv2.arrowedLine(
                image, tail, heading, (0, 200, 255),
                2, cv2.LINE_AA, tipLength=0.20,
            )
        except (ValueError, np.linalg.LinAlgError, cv2.error):
            return

    @staticmethod
    def _prompt(result, calibration, marker_roi, heading, turn_session):
        if turn_session.active:
            return f"转圈测量中：当前 {turn_session.sample_count} 点，再点【转圈测量】完成"
        if calibration["is_calibrating"]:
            return (
                f"场地标定 {len(calibration['pts_raw'])}/4："
                "依次点击 左上 → 右上 → 右下 → 左下"
            )
        if marker_roi["selecting"]:
            return "鱼尾标定：框住鱼尾附近；右键取消"
        if heading["selecting"]:
            return "鱼头方向：鱼尾自动取点，请点击鱼头中心"
        if result.yolo_status["loading"]:
            return "YOLO / CUDA 正在后台加载"
        if result.yolo_status["error"]:
            return f"YOLO 加载失败：{result.yolo_status['error']}"
        return None

    @staticmethod
    def telemetry(
        result,
        *,
        calibration,
        heading,
        turn_session,
        turn_results,
        decision,
        loop_fps,
        camera_fps,
        exposure,
        tablet_rates,
        mcu_hz,
        clahe_enabled,
    ):
        guidance = None if decision is None else _json_safe(decision.guidance)
        current = result.current_position
        control = result.control_position
        velocity = result.velocity
        tx_hz, rx_hz = tablet_rates
        return {
            "timestamp": result.frame_time,
            "track_id": result.track_id,
            "auv_detected": result.yolo_result.get("pixel") is not None,
            "pixel": {
                "u": result.pixel[0] if result.pixel else None,
                "v": result.pixel[1] if result.pixel else None,
            },
            "reference": result.reference.to_dict(),
            "initial_heading": {
                "calibrated": heading["angle_deg"] is not None,
                "tail_pixel": heading["tail_point"],
                "head_pixel": heading["head_point"],
                "angle_deg": heading["angle_deg"],
                "world_unit": heading["world_unit_vector"],
            },
            "turn_calibration": {
                "active": turn_session.active,
                "samples": turn_session.sample_count,
                "saved": {
                    direction: fit.to_dict()
                    for direction, fit in turn_results.items()
                },
            },
            "guidance": guidance,
            "yolo_bbox": _json_safe(result.yolo_bbox),
            "physical": {
                "x": current[0] if current else None,
                "y": current[1] if current else None,
                "control_x": control[0] if control else None,
                "control_y": control[1] if control else None,
                "camera_latency_s": CAMERA_LATENCY_S,
            },
            "velocity": {
                "vx": velocity[0] if velocity else None,
                "vy": velocity[1] if velocity else None,
                "speed": result.speed,
                "direction_deg": result.direction_deg,
            },
            "calibrated": calibration["H"] is not None,
            "system": {
                "loop_fps": round(loop_fps, 1),
                "camera_fps": round(camera_fps, 1),
                "yolo_fps": round(result.yolo_fps, 1),
                "yolo_confidence": round(result.yolo_confidence, 3),
                "yolo_ready": bool(result.yolo_status["ready"]),
                "yolo_loading": bool(result.yolo_status["loading"]),
                "yolo_load_seconds": result.yolo_status["load_seconds"],
                "clahe_enabled": clahe_enabled,
                "exposure": exposure,
                "tablet_tx_hz": tx_hz,
                "tablet_rx_hz": rx_hz,
                "mcu_hz": mcu_hz,
            },
        }
