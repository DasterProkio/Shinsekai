"""Open Shinsekai native PySide settings window on the Plugins page.

This is the compatibility bridge for plugins whose settings pages are Qt QWidget
contributions. WebView cannot embed those widgets into HTML, so the Web UI calls
this helper to open the real native plugin settings surface.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
os.chdir(ROOT)
os.environ.setdefault("EASYAI_PROJECT_ROOT", str(ROOT))
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))


def main() -> int:
    from PySide6.QtCore import QTimer
    from PySide6.QtWidgets import QApplication

    from config.config_manager import ConfigManager
    from i18n import init_i18n
    from ui.settings_ui import create_default_context
    from ui.settings_ui.main import MainWindow

    cm = ConfigManager()
    try:
        init_i18n(cm.config.system_config.ui_language)
    except Exception:
        init_i18n("zh_CN")

    app = QApplication(sys.argv)
    ctx = create_default_context()
    win = MainWindow(ctx)

    def open_plugins_page() -> None:
        btn = getattr(win.ui, "btn_plugins", None)
        if btn is not None:
            btn.click()
            return
        try:
            win.ui.stackedWidget.setCurrentIndex(4)
        except Exception:
            pass

    QTimer.singleShot(0, open_plugins_page)
    return app.exec()


if __name__ == "__main__":
    raise SystemExit(main())
