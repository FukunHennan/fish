# 兼容 GUI 入口

此目录加载 `../src/main.jsx`，连接真实后端，不是模拟环境。推荐改用 `controller/frontend` 下的 `npm run dev`。暂时保留本入口以兼容已有进程和预览链接。

旧的、未被入口引用的 `demo.js` 和 `demo.css` 已移至 `design/gui/archive/legacy-mock/`。`layout-demo.html` 为模拟排版讨论稿，不控制设备。
