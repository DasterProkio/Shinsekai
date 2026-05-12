# Python + QWebEngineView 桌面壳

这层只负责把 `frontend/` 的 HTML UI 装进桌面窗口，并启动同进程本地 API 服务。

## 运行

```bash
python frontend_desktop.py
```

可选参数：

```bash
python frontend_desktop.py --width 1440 --height 920 --devtools
```

## 结构

```text
frontend_desktop.py
  ├─ 启动 ThreadingHTTPServer
  ├─ 复用 frontend_api.server.ShinsekaiApiHandler
  └─ 用 PySide6.QtWebEngineWidgets.QWebEngineView 加载 http://127.0.0.1:<port>/
```

`frontend_api/server.py` 同时提供：

- `/api/*`：后端 REST 接口
- `/`、`/src/main.js`、`/src/api.js`：静态前端文件

因此桌面模式不需要 `npm run dev`，也不需要浏览器。

## 不变项

- 不修改 UI 布局元素
- 不修改 UI 颜色
- 不修改按钮文字样式
- 只新增后端接入和 WebView 壳
