# GUI 设计稿工作区

这个目录用于保存 **Fish Control Center / 机器鱼项目的 GUI 设计稿与可交互原型**，方便多人协作讨论界面、交互和功能布局。

> 这里的文件仅用于设计与评审，不是正式运行代码。正式前端代码仍位于 `controller/frontend/`。

## 目录约定

建议后续按下面的方式组织：

```text
design/gui/
├─ README.md
├─ prototypes/        # 可直接浏览器打开的 HTML 交互原型
├─ screenshots/       # 页面截图、对比图
└─ notes/             # UI/UX 说明、评审记录
```

Git 不保存空目录，因此在真正加入对应内容时再创建 `prototypes/`、`screenshots/` 和 `notes/`。

## 原型命名建议

使用清晰、稳定的英文文件名，例如：

```text
control-center.html
ap-wifi-provisioning.html
battery-status.html
ota-settings.html
vision-workspace.html
```

如果需要保留多个设计版本，可以使用：

```text
control-center-v1.html
control-center-v2.html
```

不建议在文件名中使用 `final`、`new`、`latest` 等难以长期维护的名称。

## 当前设计方向

目前 GUI 设计已经涉及：

- 多机器鱼控制台
- 视觉工作区
- OTA / 设备设置
- AP Wi-Fi 配网页面
- Wi-Fi 扫描与 SSID 快速选择
- 设备电池百分比 / 电压显示
- 低电量提醒

后续生成或修改这些设计稿时，优先将可交互 HTML 放入 `design/gui/prototypes/`。

## 协作规则

1. **设计稿和正式代码分离**：设计评审阶段只改 `design/gui/`，确认后再同步到 `controller/frontend/`。
2. **原型必须可独立打开**：HTML 原型尽量保持单文件，CSS 和 JavaScript 内嵌，方便任何人直接双击查看。
3. **不模拟不存在的正式功能**：若某个功能尚未实现，应明确标注为“设计原型”，正式 GUI 中不可伪装成已经可用。
4. **保留交互说明**：复杂交互应在 HTML 页面内或配套 Markdown 中说明。
5. **多人修改时使用独立提交**：一个界面/一个设计主题尽量对应一个 commit，方便回退和比较。

## 从设计稿进入正式开发

推荐流程：

```text
需求讨论
  ↓
HTML 可交互原型
  ↓
团队评审
  ↓
确认布局 / 交互
  ↓
React 正式实现
  ↓
接入 Go / ESP32 API
  ↓
实际设备验证
```

这样可以避免在正式前端代码中反复试布局，也方便其他开发者快速理解设计目标。
