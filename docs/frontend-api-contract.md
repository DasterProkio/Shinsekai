# Frontend API Contract

默认 base URL：

```text
http://127.0.0.1:8765
```

## Health

`GET /api/health`

```json
{ "ok": true, "version": "..." }
```

## App State

`GET /api/app-state`

返回：

```json
{
  "version": "...",
  "api_config": {},
  "system_config": {},
  "llm_providers": [],
  "characters": [],
  "backgrounds": [],
  "templates": [],
  "histories": [],
  "plugins": [],
  "mcp_config": {}
}
```

## API 配置

`GET /api/config/api`

返回的 `llm_provider` 会被规整成后端真实 adapter 名称；旧的 `OpenAI Compatible` 会映射为 `ChatGPT`。同时返回：

- `llm_provider_raw`
- `llm_provider_effective`
- `llm_model_current`
- `llm_api_key_current`
- `llm_providers`

`PUT /api/config/api`

前端提交字段：

```json
{
  "llm_provider": "Deepseek",
  "llm_model": "gpt-4-turbo-preview",
  "api_key": "<your-api-key>",
  "base_url": "https://api.openai.com/v1",
  "is_streaming": "是",
  "llm_extra_configs": {
    "Deepseek": {
      "thinking_enabled": false,
      "reasoning_effort": "high"
    }
  },
  "temperature": 0.7,
  "presence_penalty": 0,
  "frequency_penalty": 0,
  "repetition_penalty": 1,
  "max_context_tokens": 128000,

  "tts_provider": "none",
  "sovits_url": "",
  "gpt_sovits_api_path": "",

  "asr_provider": "Vosk",
  "asr_language": "跟随界面语言",
  "asr_whisper_model_size": "small",
  "asr_whisper_device": "auto",

  "t2i_provider": "ComfyUI",
  "t2i_url": "http://127.0.0.1:8188",
  "t2i_work_path": "",
  "t2i_default_workflow_path": "workflow.json",
  "prompt_node_id": "6",
  "output_node_id": "9"
}
```

`llm_extra_configs` 会合并进 `data/config/api.yaml`，供 `ConfigManager.merged_llm_factory_kwargs()` 创建 adapter 时使用。Web 服务配置页目前把 DeepSeek 的 `thinking_enabled` 暴露为“模型思考模式”开关，并保留已有 `reasoning_effort`，默认使用 `"high"`。

## Adapter 扩展配置

`PUT /api/config/adapter-extra`

```json
{
  "kind": "llm",
  "provider": "Deepseek",
  "data": {
    "thinking_enabled": true,
    "reasoning_effort": "high"
  }
}
```

`kind` 支持 `llm`、`tts`、`asr`、`t2i`。保存后写入 `api.yaml` 对应的 `*_extra_configs`。

## 服务测试

`POST /api/services/test`

当前桥接层先做字段校验，后续可替换为真实 adapter ping。

## 角色

`GET /api/characters`

`PUT /api/characters/{name}`

## 背景

`GET /api/backgrounds`

`PUT /api/backgrounds/{name}`

## 模板

`GET /api/templates`

`GET /api/templates/{filename}`

`POST /api/templates`

```json
{
  "filename": "rainy_manor.txt",
  "scenario": "...",
  "system_template": "..."
}
```

`POST /api/templates/generate`

```json
{
  "characters": ["艾莉诺·万斯"],
  "bg_name": "古堡书房",
  "use_effect": "是",
  "use_translation": "否",
  "use_cg": "否",
  "use_cot": "否",
  "use_choice": "是",
  "use_narration": "是",
  "max_speech_chars": 120,
  "max_dialog_items": 20
}
```

## 启动演出

`POST /api/launch`

```json
{
  "user_scenario": "...",
  "system_template": "...",
  "init_sprite_path": "",
  "history_file": "",
  "selected_bg": "古堡书房",
  "use_cg": "否",
  "room_id": ""
}
```

`POST /api/launch/resume`

`POST /api/launch/stop`

## 插件/MCP/工具

`GET /api/plugins`

`GET /api/plugins/catalog`

返回远端插件索引，并附带本地安装状态。

`POST /api/plugins/catalog/install`

```json
{
  "repo_url": "https://github.com/...",
  "entry": "plugins.example",
  "overwrite": false
}
```

下载插件源码并在缺失时追加 `data/config/plugins.yaml` 条目。完整启用仍需按插件类型重启应用。

`GET /api/plugins/web-detail?entry=plugins.example`

返回插件清单行、插件包信息，以及可选的 `web_config_schema`。`web_config_schema` 是 Web UI 从真实插件设置面板生成的轻量表单描述：

```json
{
  "kind": "minimax_tts",
  "title": "MiniMax TTS",
  "path": "data/plugins/com.shinsekai.minimax_tts/config.json",
  "fields": [
    { "name": "model", "label": "模型", "type": "str", "choices": ["speech-2.8-hd"] }
  ],
  "values": {}
}
```

已支持从 `config_model.py` dataclass 生成通用表单，并对当前内置插件的 Qt 设置页做专用 Web 映射：`plugins/moondream_vision/settings_tab.py`、`plugins/minimax_tts/settings.py`、`plugins/chat_ui_customize/settings_widget.py`。

`PUT /api/plugins/web-file`

保存 Web 插件表单对应文件。若请求内容带 `__web_schema_kind`，后端会按插件原本保存规则处理，例如 MiniMax TTS 会调用插件状态保存逻辑，聊天外观会重新生成 `data/chat_ui_theme.json`。

`POST /api/plugins/toggle`

`POST /api/plugins/open-settings`

`POST /api/plugins/open-manifest`

`PUT /api/plugins/manifest-row`

`DELETE /api/plugins/manifest-row/{entry}`

## MCP

`GET /api/mcp`

`PUT /api/mcp`

`POST /api/mcp/servers`

`PUT /api/mcp/servers/{index}`

`DELETE /api/mcp/servers/{index}`

`POST /api/mcp/global/toggle`

`POST /api/mcp/servers/toggle`

`GET /api/mcp/tools`

`POST /api/mcp/tools/refresh`

`POST /api/mcp/open-config`

MCP 写接口会保存 `data/config/mcp.yaml`，并尝试在当前进程重载工具；缺少 `mcp` Python 包时会返回 warning。

## 工具

`POST /api/tools/{tool}`
