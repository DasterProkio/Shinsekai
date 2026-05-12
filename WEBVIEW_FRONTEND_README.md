# Optional PySide WebView Frontend

This branch is reserved for the experimental PySide QWebEngineView frontend work.

Current local integration package: `shinsekai_plugin_only_own_panel.zip`.

Planned files:

```text
frontend/
frontend_api/
frontend_desktop.py
frontend_native_plugin_settings.py
docs/frontend-api-contract.md
docs/pywebview-desktop.md
```

Scope:

- local REST bridge for existing Shinsekai configuration and launch flows
- PySide6 QWebEngineView desktop shell
- character/background/template/MCP/plugin/launch panels
- local asset preview proxy
- plugin web settings rendering where the plugin exposes a readable config model

Notes:

- This frontend is intended to be optional and experimental.
- The existing PySide settings UI should remain available as a compatibility fallback.
- Local user data under `data/` should not be committed.
