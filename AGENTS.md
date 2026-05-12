# Shinsekai Local Agent Notes

## Project Shape

- Main native settings entrypoint: `python webui_qt.py`.
- Optional WebView frontend entrypoint: `python frontend_desktop.py`; it serves `frontend/` through `frontend_api/server.py` at `http://127.0.0.1:<port>/`.
- The standalone bridge can run as `python frontend_api/server.py --host 127.0.0.1 --port 8765`.
- User data and downloaded assets live under `data/`; do not commit local secrets, generated chat history, bundled TTS engines, or imported character assets unless explicitly requested.

## Web Frontend Rules

- Keep `docs/frontend-api-contract.md` aligned when adding or changing `frontend_api/server.py` routes.
- The Web services page persists shared LLM fields through `PUT /api/config/api`; provider-specific fields belong in `llm_extra_configs`.
- DeepSeek thinking mode is stored at `llm_extra_configs.Deepseek.thinking_enabled`; the Web UI should disable that control for providers that do not expose the field.
- `frontend/index.html` owns the static structure and CSS; `frontend/src/main.js` should wire state and API behavior without gratuitous visual rewrites.

## Verification

- Run `python3 -m py_compile frontend_api/server.py` after bridge edits.
- Run `node --check frontend/src/main.js` after Web frontend script edits.
- If dependencies are installed, `npm --prefix frontend run build` is the frontend build check; this local copy may not have Vite installed.
- For UI changes, verify live through `http://127.0.0.1:8765/` or the WebView shell and check browser console errors.

## TTS Backend Notes

- Use the `shinsekai` conda environment, not system Python, for backend smoke tests.
- Genie TTS on macOS uses the downloaded Windows bundle under `data/tts_bundles/installed/genie_tts_server/Genie-TTS Server`; the install is incomplete if `runtime/python.exe`, `runtime/Lib/site-packages/genie_tts/Server.py`, or `GenieData/speaker_encoder.onnx` is missing.
- The Genie adapter must launch the bundled `.exe` through CrossOver/Wine on macOS and send Windows-readable paths to the service. Do not pass raw `/Users/...` paths to `/load_character` or `/set_reference_audio`.
- When TTS is configured but new chats have no sound, verify `http://127.0.0.1:9880/docs`, then run a real `TTSManager.generate_tts()` smoke test. See `docs/TTS_BACKEND_RUNBOOK.md`.
