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
  "characters": [],
  "backgrounds": [],
  "templates": [],
  "plugins": []
}
```

## API 配置

`GET /api/config/api`

`PUT /api/config/api`

前端提交字段：

```json
{
  "llm_provider": "OpenAI Compatible",
  "llm_model": "gpt-4-turbo-preview",
  "api_key": "<your-api-key>",
  "base_url": "https://api.openai.com/v1",
  "is_streaming": "是",
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

`POST /api/mcp/tools/refresh`

`POST /api/tools/{tool}`
