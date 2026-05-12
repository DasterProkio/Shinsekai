"""Shinsekai WebView 桌面壳。

只负责把 frontend/ 的现有 HTML UI 装进 PySide6 QWebEngineView，
并在同一进程里启动本地 REST API/静态文件服务。

运行：
    python frontend_desktop.py

说明：
    - 不修改 frontend/index.html 的布局、颜色、按钮样式。
    - API 服务默认只监听 127.0.0.1，并自动选择空闲端口。
    - QWebEngineView 加载 http://127.0.0.1:<port>/，前端同源调用 /api/*。
"""

from __future__ import annotations

import argparse
import os
import socket
import sys
import threading
from pathlib import Path

ROOT = Path(__file__).resolve().parent
os.chdir(ROOT)
os.environ.setdefault("EASYAI_PROJECT_ROOT", str(ROOT))
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from frontend_api.server import ShinsekaiApiHandler, ThreadingHTTPServer  # noqa: E402


def _free_port(host: str = "127.0.0.1") -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind((host, 0))
        return int(sock.getsockname()[1])


class DesktopServer:
    def __init__(self, host: str, port: int) -> None:
        self.host = host
        self.port = port
        self.httpd = ThreadingHTTPServer((host, port), ShinsekaiApiHandler)
        self.thread = threading.Thread(target=self.httpd.serve_forever, daemon=True)

    def start(self) -> None:
        self.thread.start()

    def shutdown(self) -> None:
        self.httpd.shutdown()
        self.httpd.server_close()
        self.thread.join(timeout=2)


class ShinsekaiWebViewApp:
    def __init__(self, host: str, port: int, width: int, height: int, devtools: bool) -> None:
        from PySide6.QtCore import QUrl
        from PySide6.QtWidgets import QApplication, QMainWindow
        from PySide6.QtWebEngineWidgets import QWebEngineView

        self.server = DesktopServer(host, port)
        self.server.start()

        self.app = QApplication.instance() or QApplication(sys.argv)
        self.window = QMainWindow()
        self.window.setWindowTitle("新世界")
        self.window.resize(width, height)

        self.view = QWebEngineView()
        self.view.setUrl(QUrl(f"http://{host}:{port}/"))
        self.window.setCentralWidget(self.view)

        if devtools:
            from PySide6.QtWebEngineWidgets import QWebEngineView as _QWebEngineView

            self.devtools = _QWebEngineView()
            self.view.page().setDevToolsPage(self.devtools.page())
            self.devtools.resize(980, 720)
            self.devtools.show()
        else:
            self.devtools = None

        self.app.aboutToQuit.connect(self.server.shutdown)

    def run(self) -> int:
        self.window.show()
        return int(self.app.exec())


def main() -> None:
    parser = argparse.ArgumentParser(description="Shinsekai WebView desktop shell")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=0, help="0 表示自动选择空闲端口")
    parser.add_argument("--width", type=int, default=1440)
    parser.add_argument("--height", type=int, default=920)
    parser.add_argument("--devtools", action="store_true")
    args = parser.parse_args()

    port = args.port or _free_port(args.host)
    app = ShinsekaiWebViewApp(args.host, port, args.width, args.height, args.devtools)
    raise SystemExit(app.run())


if __name__ == "__main__":
    main()
