# TTS Backend Runbook

This note is for backend troubleshooting when a chat session starts but synthesized speech does not render.

## Runtime Shape

- Chat launch flows through `ui/settings_ui/services/chat_template_handlers.py::launch_chat()`, which starts `main.py` with `--tts=<slug>`.
- `main.py` creates a `TTSManager` and a concrete adapter through `TTSAdapterFactory`.
- Genie TTS serves HTTP on `http://127.0.0.1:9880/`; the chat process calls `/load_character`, `/set_reference_audio`, then `/tts`.

## Required Config

`data/config/api.yaml` should point Genie at the local bundle:

```yaml
tts_provider: genie-tts
gpt_sovits_url: http://127.0.0.1:9880/
gpt_sovits_api_path: data/tts_bundles/installed/genie_tts_server/Genie-TTS Server
```

Do not copy or log API keys from the same file while debugging.

## macOS Genie Bundle Checks

The bundled Genie runtime is a Windows runtime. On macOS it must be launched through CrossOver or Wine, and filesystem paths sent to the service must be Windows-readable paths such as `Y:\Downloads\Shinsekai\onnx\...`.

The extracted bundle is incomplete if any of these are missing:

```text
data/tts_bundles/installed/genie_tts_server/Genie-TTS Server/runtime/python.exe
data/tts_bundles/installed/genie_tts_server/Genie-TTS Server/runtime/Lib/site-packages/genie_tts/Server.py
data/tts_bundles/installed/genie_tts_server/Genie-TTS Server/GenieData/speaker_encoder.onnx
```

If the installed directory has mostly folders but no `runtime` files, re-extract the downloaded archive with system 7-Zip:

```bash
7zz x -y -odata/tts_bundles/installed/genie_tts_server/ \
  data/tts_bundles/downloads/Genie-TTS\ Server.7z
```

## Smoke Tests

Use the project environment:

```bash
cd /Users/daster/Downloads/Shinsekai
source /opt/homebrew/Caskroom/miniforge/base/bin/activate shinsekai
python -m py_compile tts/tts_adapter.py tts/tts_manager.py ui/settings_ui/tts/tts_bundle_worker.py
curl -sS --max-time 2 http://127.0.0.1:9880/docs | head
```

If `9880` is down, instantiate `GenieTTSAdapter`; it should auto-start the server when the bundle path is valid. After startup, verify with a real `TTSManager.generate_tts()` call and check that the resulting `cache/audio/*.wav` is a readable WAV.

## Common Failure Signals

- `Genie TTS runtime not found`: the bundle did not fully extract.
- `start.py not found`: older or partial bundles may not expose this helper; current code falls back to `genie_tts.Server`.
- `/load_character` returns 200 but `/tts` is empty: the Windows runtime probably received raw POSIX paths. Convert ONNX and reference audio paths with `winepath` before sending them to Genie.
