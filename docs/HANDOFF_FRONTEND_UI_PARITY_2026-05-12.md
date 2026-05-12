# Shinsekai Web Frontend UI Parity Handoff

Date: 2026-05-12

This handoff covers the Web/PySide QWebEngine frontend parity pass against the original PySide UI. The user explicitly broadened the scope from the plugin page to the whole frontend and required multiple subagents plus rendered UI simulation.

## Environment

Use the project environment, not system Python:

```bash
cd /Users/daster/Downloads/Shinsekai
source /opt/homebrew/Caskroom/miniforge/base/bin/activate shinsekai
python frontend_desktop.py
```

For isolated browser/API testing, the REST bridge can be started separately:

```bash
cd /Users/daster/Downloads/Shinsekai
source /opt/homebrew/Caskroom/miniforge/base/bin/activate shinsekai
python frontend_api/server.py --host 127.0.0.1 --port 8765
```

The bridge serves `frontend/` and exposes the API under `http://127.0.0.1:8765`.

## Files Changed In This Pass

- `frontend_api/server.py`
  - Initializes i18n before shared SettingsUI services are used.
  - Enriches plugin rows with static metadata from plugin source files so disabled/unloaded plugins still show real names, descriptions, versions, settings/tools hints.
  - Prevents disabled plugins from borrowing runtime contributions from unrelated loaded plugins.
  - Adds lightweight `plugins.yaml` helpers for Web bridge manifest edits.
  - Adds plugin catalog endpoints:
    - `GET /api/plugins/catalog`
    - `POST /api/plugins/catalog/install`
- `frontend/src/api.js`
  - Adds `listPluginCatalog()`.
  - Adds `installCatalogPlugin(payload)`.
- `frontend/src/main.js`
  - Adds Services -> Plugin Service -> `管理插件 / 发现插件` panel switching.
  - Renders remote registry catalog rows with installed/downloaded state, GitHub links, and install/update buttons.
  - Adds install confirmation before downloading a plugin or installing `requirements.txt`.
  - Preserves existing character `sprites`, `emotion_tags`, background `sprites`, `bgm_list`, and `bgm_tags` when the compact Web editor saves basic fields.
- `frontend/index.html`
  - Adds the plugin discovery panel markup.
  - Adds mobile layout fixes so narrow screens use a single-column scrollable layout instead of crushing the desktop three-column grid.
  - Moves floating utility buttons into a compact bottom pill on mobile.

There were already unrelated dirty files before this handoff, including docs, TTS files, and `AGENTS.md`. Do not revert them unless the user asks.

## Validation Already Run

Commands:

```bash
source /opt/homebrew/Caskroom/miniforge/base/bin/activate shinsekai
python -m py_compile frontend_api/server.py
node --check frontend/src/api.js
node --check frontend/src/main.js
git diff --check
```

API smoke:

```bash
curl -sS http://127.0.0.1:8765/api/health
curl -sS http://127.0.0.1:8765/api/plugins
curl -sS http://127.0.0.1:8765/api/plugins/catalog
```

Observed catalog result: 5 registry plugins, including `playwright_browser` and `minimax_tts`. Installed plugins were correctly marked as installed/updateable; missing registry plugins were marked installable.

Rendered checks:

- Desktop `1280x720`: Services loads, plugin discovery opens, catalog fetches, no console error/warn.
- Mobile `390x844`: plugin discovery remains readable and scrollable, no console error/warn.
- Main nav: Services, Characters, Scenes, Sessions, Launch all switch to the intended active screen.
- Non-destructive modal buttons checked: About, utility buttons, plugin settings, character voice/sprite editors, scene detail editor, session template editor.

Not exercised on purpose:

- Actual plugin install/update click after confirmation.
- Launch/resume/clear-history buttons, because they can start external chat processes or mutate live session state.
- Delete buttons in full editors.

## Subagent Coverage

More than 5 subagents were used. Completed results that informed this handoff:

- Plugin parity: native PySide plugin tab has `管理插件 / 发现插件 / MCP`; Web originally had only a small installed list and local refresh.
- Plugin UX/IA: Web needed a real discovery workbench, status/progress, persistent error states, and clearer local vs remote refresh semantics.
- Character/background/music-cover parity: Web lacks full `.char/.bg` import/export, community resource browsing, upload flows, sprite/BGM detailed management, and the Music Cover page.
- Sessions/launch parity: core template/generate/launch surfaces exist, but history restore and quick restart semantics are not at native parity.

Several long-running/retasked agents were closed after timeout. Treat the completed findings plus local rendered testing as the reliable source for this pass.

## Original UI Features Still Missing Or Partial In Web

P0/P1 gaps:

- Plugin discovery is now present, but still lacks native-level progress log UI, version/tag selector, self-update button, and full MCP tab parity.
- Character page still lacks real `.char` import/export, community resource browser, file upload, color picker UX parity, and full memory add/delete workflows.
- Background page still lacks real `.bg` import/export, community resource browser, image upload/delete/tags parity, BGM upload/delete/batch management, and AI translate backend parity.
- Music Cover has native configuration fields and pipeline controls but no Web page/API equivalent.
- Session histories are listed but not a full native-style clickable restore/workflow surface.
- `清空历史并启动` and native quick restart semantics need a source-of-truth review before shipping as equivalent.
- Launch process state is process-local to the current bridge; restarting the bridge loses monitor state.

P2/UI polish:

- Plugin install currently uses a blocking request path. Native has a dialog with download bytes and pip logs; Web should eventually stream progress or poll job status.
- Some duplicated buttons, such as `+ 新建角色` and `+ 新建场景`, exist in both sidebar and pane header. They are usable but make exact locator tests ambiguous.
- The floating P/B/C utility tools are now mobile-safe but still overlap content near the bottom if the user stops mid-list; padding was added, but deeper mobile QA is still useful.

## Recommended Next Implementation Order

1. Finish plugin discovery parity:
   - Add progress/job API for download + pip logs.
   - Add ref selection: latest release, default branch, explicit tag.
   - Add Web MCP tab parity or route the user clearly to MCP editing.
   - Add uninstall/remove downloaded mapping parity.

2. Make character/background resource flows real:
   - `.char` and `.bg` import/export endpoints.
   - Upload endpoints for sprites, background images, BGM.
   - Delete and tag editing with confirmations.
   - Preserve existing arrays and config data on every compact-save path.

3. Add Music Cover Web surface:
   - Mirror `music_cover_*` fields from `system_config`.
   - Add yt-dlp/ffmpeg/UVR/RVC config editing.
   - Do not run long pipelines directly in request handlers; use jobs.

4. Tighten session/launch:
   - Make history rows clickable and restoreable.
   - Reconcile `清空历史并启动` against native behavior.
   - Add confirmation for destructive history/session actions.
   - Keep launch monitor state observable after bridge reload where possible.

## Important Cautions

- Do not use system Python for this project. The tested environment is the `shinsekai` conda environment under `/opt/homebrew/Caskroom/miniforge/base`.
- Do not commit local user data under `data/`.
- Do not expose API keys from `api.yaml` or `/api/app-state` in docs, logs, or screenshots.
- Do not click launch/install/delete buttons during QA unless the user explicitly asks, because they can mutate files, install dependencies, or start external processes.
- The Web bridge reads static frontend files from disk per request, but Python server changes require restarting the bridge process.

## Quick Restart Checklist For Next Agent

```bash
cd /Users/daster/Downloads/Shinsekai
source /opt/homebrew/Caskroom/miniforge/base/bin/activate shinsekai
python -m py_compile frontend_api/server.py
node --check frontend/src/api.js
node --check frontend/src/main.js
git diff --check
python frontend_api/server.py --host 127.0.0.1 --port 8765
```

Then open `http://127.0.0.1:8765/`, go to Services -> 插件服务 -> 发现插件, and verify the catalog reads the remote registry and shows install/update states without console errors.
