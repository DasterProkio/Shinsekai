"""Shinsekai 前端 REST 桥接服务。

运行：
    python frontend_api/server.py --host 127.0.0.1 --port 8765

说明：
    这是给 frontend/ 这套静态前端使用的轻量 API 层。
    不修改任何现有 UI；只把前端按钮绑定到 Shinsekai 已有配置/模板/启动逻辑。
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import mimetypes
import platform
import subprocess
import time
import traceback
import re
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, unquote, urlparse

ROOT = Path(__file__).resolve().parents[1]
os.chdir(ROOT)
os.environ.setdefault("EASYAI_PROJECT_ROOT", str(ROOT))
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))


_i18n_ready = False


def _ensure_i18n_initialized() -> None:
    """Initialize runtime translations for the Web bridge before using shared services."""
    global _i18n_ready
    if _i18n_ready:
        return
    try:
        from config.config_manager import ConfigManager
        from i18n import init_i18n

        init_i18n(ConfigManager().config.system_config.ui_language)
    except Exception:
        from i18n import init_i18n

        init_i18n("zh_CN")
    _i18n_ready = True


def _json_safe(value: Any) -> Any:
    """Convert pydantic/path/http-url objects into JSON serializable values."""
    if hasattr(value, "model_dump"):
        return _json_safe(value.model_dump(mode="json", by_alias=True))
    if isinstance(value, dict):
        return {str(k): _json_safe(v) for k, v in value.items()}
    if isinstance(value, (list, tuple, set)):
        return [_json_safe(v) for v in value]
    if isinstance(value, Path):
        return str(value)
    return value


def _plugin_manifest_path() -> Path:
    return ROOT / "data" / "config" / "plugins.yaml"


def _parse_yaml_scalar(value: str) -> Any:
    raw = value.strip()
    if not raw:
        return ""
    if raw.lower() in {"true", "false"}:
        return raw.lower() == "true"
    if raw.lower() in {"null", "none", "~"}:
        return None
    if (raw.startswith('"') and raw.endswith('"')) or (raw.startswith("'") and raw.endswith("'")):
        try:
            return json.loads(raw) if raw.startswith('"') else raw[1:-1].replace("''", "'")
        except Exception:
            return raw.strip("\"'")
    return raw


def _read_plugin_manifest_items_light(path: Path | None = None) -> list[dict[str, Any]]:
    """Read plugins.yaml without importing PySide-heavy plugin_host."""
    p = path if path is not None else _plugin_manifest_path()
    if not p.is_file():
        return []
    text = p.read_text(encoding="utf-8")
    try:
        import yaml

        raw = yaml.safe_load(text) or []
        if not isinstance(raw, list):
            return []
        return [
            dict(item)
            for item in raw
            if isinstance(item, dict) and isinstance(item.get("entry"), str) and item.get("entry").strip()
        ]
    except Exception:
        pass

    items: list[dict[str, Any]] = []
    current: dict[str, Any] | None = None

    def put_pair(target: dict[str, Any], chunk: str) -> None:
        if ":" not in chunk:
            return
        key, value = chunk.split(":", 1)
        key = key.strip()
        if not key:
            return
        target[key] = _parse_yaml_scalar(value)

    for raw_line in text.splitlines():
        if not raw_line.strip() or raw_line.lstrip().startswith("#"):
            continue
        if raw_line.startswith("- "):
            if current and isinstance(current.get("entry"), str) and current.get("entry").strip():
                items.append(current)
            current = {}
            put_pair(current, raw_line[2:].strip())
        elif current is not None and raw_line.startswith(("  ", "\t")):
            put_pair(current, raw_line.strip())
    if current and isinstance(current.get("entry"), str) and current.get("entry").strip():
        items.append(current)
    return items


def _format_yaml_scalar(value: Any) -> str:
    if isinstance(value, bool):
        return "true" if value else "false"
    if value is None:
        return "null"
    if isinstance(value, (int, float)):
        return str(value)
    text = str(value)
    if re.fullmatch(r"[A-Za-z0-9_./:@+-]+", text):
        return text
    return json.dumps(text, ensure_ascii=False)


def _write_plugin_manifest_items_light(items: list[dict[str, Any]], path: Path | None = None) -> None:
    p = path if path is not None else _plugin_manifest_path()
    p.parent.mkdir(parents=True, exist_ok=True)
    try:
        import yaml

        p.write_text(
            yaml.safe_dump(items, allow_unicode=True, sort_keys=False, default_flow_style=False),
            encoding="utf-8",
        )
        return
    except Exception:
        pass
    lines: list[str] = []
    for item in items:
        entry = str(item.get("entry") or "").strip()
        if not entry:
            continue
        lines.append(f"- entry: {_format_yaml_scalar(entry)}")
        for key, value in item.items():
            if key == "entry":
                continue
            lines.append(f"  {key}: {_format_yaml_scalar(value)}")
    p.write_text("\n".join(lines) + ("\n" if lines else ""), encoding="utf-8")


def _normalize_manifest_entry_light(entry: str) -> str:
    norm = str(entry or "").strip()
    if not norm:
        return norm
    if norm.startswith("plugins."):
        return norm
    return f"plugins.{norm}"


def _infer_plugin_package_directory_light(entry: str) -> Path | None:
    raw = str(entry or "").strip()
    if not raw:
        return None
    mod = raw.split(":", 1)[0].strip()
    if not mod.startswith("plugins."):
        mod = _normalize_manifest_entry_light(mod)
    rest = mod.removeprefix("plugins.")
    top = rest.split(".", 1)[0].strip()
    return Path("plugins") / top if top else None


def _append_plugin_manifest_entry_if_missing_light(entry: str, *, enabled: bool = True) -> str:
    norm = _normalize_manifest_entry_light(entry)
    if not norm:
        return "empty"
    items = _read_plugin_manifest_items_light()
    for item in items:
        if str(item.get("entry") or "").strip() == norm:
            return "exists"
    items.append({"entry": norm, "enabled": bool(enabled)})
    _write_plugin_manifest_items_light(items)
    return "added"


def _set_plugin_manifest_enabled_light(entry: str, enabled: bool) -> bool:
    norm = str(entry or "").strip()
    items = _read_plugin_manifest_items_light()
    changed = False
    for item in items:
        if str(item.get("entry") or "").strip() == norm:
            item["enabled"] = bool(enabled)
            changed = True
            break
    if changed:
        _write_plugin_manifest_items_light(items)
    return changed


def _remove_plugin_manifest_entry_light(entry: str) -> bool:
    norm = str(entry or "").strip()
    items = _read_plugin_manifest_items_light()
    kept = [item for item in items if str(item.get("entry") or "").strip() != norm]
    if len(kept) == len(items):
        return False
    _write_plugin_manifest_items_light(kept)
    return True




LLM_PROVIDER_ALIASES = {
    "openai compatible": "ChatGPT",
    "openai-compatible": "ChatGPT",
    "openai_compatible": "ChatGPT",
    "openai compat": "ChatGPT",
    "openai": "ChatGPT",
    "chatgpt": "ChatGPT",
    "openai 兼容": "ChatGPT",
    "openai兼容": "ChatGPT",
    "openai兼容端点": "ChatGPT",
    "openai兼容接口": "ChatGPT",
    "openai compatible / chatgpt": "ChatGPT",
}


def _normalize_llm_provider_name(value: Any) -> str:
    """Map Web UI aliases to the canonical Shinsekai LLM adapter key."""
    raw = str(value or "").strip()
    if not raw:
        return raw
    lowered = raw.lower().strip()
    if lowered in LLM_PROVIDER_ALIASES:
        return LLM_PROVIDER_ALIASES[lowered]
    try:
        from llm.llm_manager import LLMAdapterFactory
        for key in LLMAdapterFactory._adapters.keys():
            if key.lower() == lowered:
                return key
    except Exception:
        pass
    return raw


def _provider_map_value(mapping: Any, provider: str, default: str = "") -> str:
    if not isinstance(mapping, dict):
        return default
    keys = [provider]
    if provider == "ChatGPT":
        keys.extend(["OpenAI Compatible", "openai compatible", "OpenAI", "openai"])
    for key in keys:
        if key in mapping and mapping.get(key) not in (None, ""):
            return str(mapping.get(key))
    lowered = {str(k).lower(): v for k, v in mapping.items()}
    for key in keys:
        v = lowered.get(str(key).lower())
        if v not in (None, ""):
            return str(v)
    return default


def _normalize_extra_config_value(value: Any) -> Any:
    if isinstance(value, dict):
        return {str(k): _normalize_extra_config_value(v) for k, v in value.items()}
    if isinstance(value, list):
        return [_normalize_extra_config_value(v) for v in value]
    if isinstance(value, str):
        lowered = value.strip().lower()
        if lowered in {"true", "yes", "on", "1", "是", "启用", "enabled"}:
            return True
        if lowered in {"false", "no", "off", "0", "否", "关闭", "disabled"}:
            return False
    return value


def _llm_provider_rows() -> list[dict[str, Any]]:
    """Return real LLM adapters supported by the current process for the Web select."""
    try:
        from llm.constants import LLM_BASE_URLS
        from llm.llm_manager import LLMAdapterFactory
        try:
            from core.plugins.plugin_host import ensure_plugins_loaded
            ensure_plugins_loaded(_config_manager())
        except Exception:
            traceback.print_exc()

        adapters = dict(LLMAdapterFactory._adapters)
        ordered: list[str] = []
        for key in LLM_BASE_URLS.keys():
            if key in adapters:
                ordered.append(key)
        for key in sorted(adapters.keys(), key=str.lower):
            if key not in ordered:
                ordered.append(key)

        rows = []
        for key in ordered:
            aliases: list[str] = []
            label = key
            if key == "ChatGPT":
                label = "ChatGPT / OpenAI Compatible"
                aliases = ["OpenAI Compatible", "OpenAI", "OpenAI兼容"]
            rows.append({
                "id": key,
                "label": label,
                "aliases": aliases,
                "base_url": str(LLM_BASE_URLS.get(key, "") or ""),
                "supported": True,
            })
        return rows
    except Exception:
        traceback.print_exc()
        return [
            {"id": "Deepseek", "label": "Deepseek", "aliases": [], "base_url": "", "supported": True},
            {"id": "ChatGPT", "label": "ChatGPT / OpenAI Compatible", "aliases": ["OpenAI Compatible", "OpenAI", "OpenAI兼容"], "base_url": "", "supported": True},
            {"id": "Gemini", "label": "Gemini", "aliases": [], "base_url": "", "supported": True},
            {"id": "Claude", "label": "Claude", "aliases": [], "base_url": "", "supported": True},
            {"id": "豆包", "label": "豆包", "aliases": [], "base_url": "", "supported": True},
            {"id": "通义千问", "label": "通义千问", "aliases": [], "base_url": "", "supported": True},
        ]


def _supported_llm_provider_ids() -> set[str]:
    return {str(row.get("id")) for row in _llm_provider_rows() if row.get("id")}


def _repair_legacy_llm_provider_config() -> None:
    """Fix legacy Web UI value 'OpenAI Compatible' before launching main.py."""
    cm = _config_manager()
    api = cm.config.api_config
    current = str(api.llm_provider or "").strip()
    canonical = _normalize_llm_provider_name(current)
    if canonical == current and canonical in _supported_llm_provider_ids():
        return
    if canonical not in _supported_llm_provider_ids():
        return

    ac = api.model_copy(deep=True)
    old_model = _provider_map_value(ac.llm_model, current, "")
    old_key = _provider_map_value(ac.llm_api_key, current, "")
    if old_model:
        ac.llm_model[canonical] = old_model
    if old_key:
        ac.llm_api_key[canonical] = old_key
    ac.llm_provider = canonical
    cm.config.api_config = ac
    cm.save_api_config()


def _ctx():
    """Create SettingsUIContext lazily so the server can start from repo root."""
    _ensure_i18n_initialized()
    from config.config_manager import ConfigManager

    cm = ConfigManager()

    try:
        from ui.settings_ui import create_default_context

        return create_default_context()
    except Exception:
        # Fallback context with fields used by service handlers.
        class _FallbackContext:
            config_manager = cm
            template_dir_path = str(ROOT / "data" / "character_templates")
            history_dir = str(ROOT / "data" / "chat_history")
            template_generator = None

        return _FallbackContext()


def _config_manager():
    from config.config_manager import ConfigManager

    return ConfigManager()


def _contains_cjk(text: Any) -> bool:
    s = str(text or "")
    return any("\u4e00" <= ch <= "\u9fff" for ch in s)


def _plugin_default_name_from_id(plugin_id: str) -> str:
    pid = str(plugin_id or "").strip()
    tail = pid.rpartition(".")[-1]
    return (tail.replace("_", " " ).strip() or pid).strip()


def _plugin_overrides_property(plugin: Any, name: str) -> bool:
    if plugin is None:
        return False
    try:
        from sdk.plugin import PluginBase
    except Exception:
        PluginBase = None  # type: ignore[assignment]
    for cls in getattr(plugin, "__class__", type(plugin)).mro():
        if name in getattr(cls, "__dict__", {}):
            if PluginBase is not None and cls is PluginBase:
                return False
            return True
    return False


def _const_str_from_ast(node: Any) -> str:
    import ast

    if isinstance(node, ast.Constant) and isinstance(node.value, str):
        return node.value.strip()
    if isinstance(node, ast.JoinedStr):
        parts: list[str] = []
        for v in node.values:
            if isinstance(v, ast.Constant) and isinstance(v.value, str):
                parts.append(v.value)
            else:
                return ""
        return "".join(parts).strip()
    return ""


def _static_plugin_metadata(package_dir: Path | None) -> dict[str, Any]:
    """Read plugin-facing labels from source without executing heavy plugin imports.

    Some plugins do not override PluginBase.plugin_name, so runtime metadata falls back
    to an English/package-like tail such as "moondream vision". Their real Chinese
    label may live in ToolsTabContribution(title=...) or SettingsUIContribution(nav_label=...).
    This helper extracts those constant labels from plugin.py so the Web UI can display
    the same human-facing names as the native settings/tools tabs.
    """
    out: dict[str, Any] = {
        "plugin_id": "",
        "plugin_version": "",
        "plugin_name": "",
        "plugin_description": "",
        "plugin_author": "",
        "settings_labels": [],
        "tools_titles": [],
        "labels": [],
        "settings_count": 0,
        "tools_count": 0,
    }
    if package_dir is None or not package_dir.exists():
        return out
    plugin_py = package_dir / "plugin.py"
    if not plugin_py.is_file():
        return out
    try:
        import ast
        tree = ast.parse(plugin_py.read_text(encoding="utf-8"), filename=str(plugin_py))
    except Exception:
        return out

    def call_name(node: Any) -> str:
        if isinstance(node, ast.Name):
            return node.id
        if isinstance(node, ast.Attribute):
            return node.attr
        return ""

    for node in ast.walk(tree):
        if isinstance(node, ast.Call):
            name = call_name(node.func)
            if name in {"SettingsUIContribution", "ToolsTabContribution"}:
                if name == "SettingsUIContribution":
                    out["settings_count"] += 1
                else:
                    out["tools_count"] += 1
                for kw in node.keywords:
                    key = str(kw.arg or "")
                    val = _const_str_from_ast(kw.value)
                    if not val:
                        continue
                    if key == "nav_label":
                        out["settings_labels"].append(val)
                        out["labels"].append(val)
                    elif key == "title":
                        out["tools_titles"].append(val)
                        out["labels"].append(val)
        elif isinstance(node, ast.ClassDef):
            doc = ast.get_docstring(node)
            if doc and not out["plugin_description"]:
                out["plugin_description"] = doc.strip()
            for item in node.body:
                if not isinstance(item, ast.FunctionDef):
                    continue
                if item.name not in {"plugin_id", "plugin_version", "plugin_name", "plugin_description", "plugin_author"}:
                    continue
                is_property = any(
                    isinstance(d, ast.Name) and d.id == "property"
                    or isinstance(d, ast.Attribute) and d.attr == "property"
                    for d in item.decorator_list
                )
                if not is_property:
                    continue
                for stmt in item.body:
                    if isinstance(stmt, ast.Return):
                        val = _const_str_from_ast(stmt.value)
                        if val:
                            out[item.name] = val
                        break

    # de-duplicate while preserving order
    for key in ("settings_labels", "tools_titles", "labels"):
        seen: set[str] = set()
        deduped: list[str] = []
        for v in out[key]:
            sv = str(v or "").strip()
            if sv and sv not in seen:
                seen.add(sv)
                deduped.append(sv)
        out[key] = deduped
    return out


def _pick_plugin_display_name(
    *,
    item: dict[str, Any],
    plugin: Any,
    plugin_id: str,
    plugin_name: str,
    contribution_label: str,
    static_meta: dict[str, Any],
    entry_tail: str,
) -> str:
    manifest_label = str(
        item.get("display_name")
        or item.get("name")
        or item.get("title")
        or item.get("label")
        or ""
    ).strip()
    static_labels = [str(x or "").strip() for x in static_meta.get("labels") or [] if str(x or "").strip()]
    static_plugin_name = str(static_meta.get("plugin_name") or "").strip()
    explicit_runtime_plugin_name = plugin_name if _plugin_overrides_property(plugin, "plugin_name") else ""

    default_tail_name = _plugin_default_name_from_id(plugin_id)
    runtime_name_is_default = bool(plugin_name) and plugin_name.strip().lower() == default_tail_name.lower()

    candidates: list[str] = []
    if manifest_label:
        candidates.append(manifest_label)
    # Prefer Chinese / localized tab labels over PluginBase's fallback package-like name.
    for label in [contribution_label, *static_labels, static_plugin_name, explicit_runtime_plugin_name]:
        if label and _contains_cjk(label):
            candidates.append(label)
    for label in [contribution_label, *static_labels, static_plugin_name, explicit_runtime_plugin_name]:
        if label:
            candidates.append(label)
    if plugin_name and not runtime_name_is_default:
        candidates.append(plugin_name)
    if plugin_name:
        candidates.append(plugin_name)
    if default_tail_name:
        candidates.append(default_tail_name)
    candidates.extend([plugin_id, entry_tail])

    for c in candidates:
        c = str(c or "").strip()
        if c:
            return c
    return "未命名插件"


def _templates_dir(ctx) -> Path:
    p = Path(getattr(ctx, "template_dir_path", ROOT / "data" / "character_templates"))
    p.mkdir(parents=True, exist_ok=True)
    return p


def _plugins_manifest() -> list[dict[str, Any]]:
    """Raw plugins.yaml rows. Kept for fallback compatibility."""
    path = ROOT / "data" / "config" / "plugins.yaml"
    if not path.is_file():
        return []
    try:
        import yaml

        data = yaml.safe_load(path.read_text(encoding="utf-8")) or []
        return data if isinstance(data, list) else []
    except Exception:
        traceback.print_exc()
        return []


def _plugin_rows() -> list[dict[str, Any]]:
    """Return manifest rows enriched with loaded plugin metadata and contribution hints."""
    try:
        from core.plugins.plugin_host import (
            collect_settings_contributions,
            collect_tools_tab_contributions,
            ensure_plugins_loaded,
            get_plugin_manager,
            infer_plugin_package_directory,
            read_plugin_manifest_items,
        )

        cm = _config_manager()
        try:
            ensure_plugins_loaded(cm)
        except Exception:
            traceback.print_exc()
        mgr = get_plugin_manager()

        settings = []
        tools = []
        try:
            settings = collect_settings_contributions()
        except Exception:
            traceback.print_exc()
        try:
            tools = collect_tools_tab_contributions()
        except Exception:
            traceback.print_exc()

        def _match_plugin(entry: str):
            if mgr is None:
                return None
            norm = entry.strip()
            try:
                plugins = list(mgr.plugins)
            except Exception:
                traceback.print_exc()
                return None
            for p in plugins:
                cls = p.__class__
                full = f"{cls.__module__}:{cls.__qualname__}"
                if full == norm:
                    return p
                if ":" not in norm and cls.__module__ == norm:
                    return p
            return None

        rows: list[dict[str, Any]] = []
        for item in read_plugin_manifest_items():
            entry = str(item.get("entry") or "").strip()
            enabled = item.get("enabled") is not False
            plugin = _match_plugin(entry) if enabled else None
            plugin_id = str(getattr(plugin, "plugin_id", "") or "")
            plugin_version = str(getattr(plugin, "plugin_version", "") or "")
            plugin_name = str(getattr(plugin, "plugin_name", "") or "")
            plugin_description = str(getattr(plugin, "plugin_description", "") or "")
            plugin_author = str(getattr(plugin, "plugin_author", "") or "")
            package_dir = infer_plugin_package_directory(entry)
            package_abs = (ROOT / package_dir) if package_dir is not None else None
            static_meta = _static_plugin_metadata(package_abs)
            effective_plugin_id = plugin_id or str(static_meta.get("plugin_id") or "").strip()
            effective_plugin_version = plugin_version or str(static_meta.get("plugin_version") or "").strip()
            effective_plugin_name = plugin_name or str(static_meta.get("plugin_name") or "").strip()
            effective_plugin_description = plugin_description or str(static_meta.get("plugin_description") or "").strip()
            effective_plugin_author = plugin_author or str(static_meta.get("plugin_author") or "").strip()
            entry_tail = entry.rpartition(":")[2] or entry.rpartition(".")[2] or entry

            settings_meta = [
                {
                    "page_id": str(getattr(c, "page_id", "")),
                    "nav_label": str(getattr(c, "nav_label", "")),
                    "plugin_id": str(getattr(c, "plugin_id", "") or ""),
                    "plugin_version": str(getattr(c, "plugin_version", "") or ""),
                }
                for c in settings
                if effective_plugin_id and str(getattr(c, "plugin_id", "") or "") == effective_plugin_id
            ]
            tools_meta = [
                {
                    "tab_id": str(getattr(c, "tab_id", "")),
                    "title": str(getattr(c, "title", "")),
                    "plugin_id": str(getattr(c, "plugin_id", "") or ""),
                    "plugin_version": str(getattr(c, "plugin_version", "") or ""),
                }
                for c in tools
                if effective_plugin_id and str(getattr(c, "plugin_id", "") or "") == effective_plugin_id
            ]

            contribution_label = ""
            for c in settings_meta:
                if str(c.get("nav_label") or "").strip():
                    contribution_label = str(c.get("nav_label")).strip()
                    break
            if not contribution_label:
                for c in tools_meta:
                    if str(c.get("title") or "").strip():
                        contribution_label = str(c.get("title")).strip()
                        break

            if not settings_meta:
                settings_meta = [
                    {"page_id": "", "nav_label": label, "plugin_id": effective_plugin_id, "plugin_version": effective_plugin_version, "source": "static"}
                    for label in static_meta.get("settings_labels") or []
                ]
            if not tools_meta:
                tools_meta = [
                    {"tab_id": "", "title": title, "plugin_id": effective_plugin_id, "plugin_version": effective_plugin_version, "source": "static"}
                    for title in static_meta.get("tools_titles") or []
                ]
            if not contribution_label:
                for label in [*(static_meta.get("settings_labels") or []), *(static_meta.get("tools_titles") or [])]:
                    if str(label or "").strip():
                        contribution_label = str(label).strip()
                        break

            # The Web service card should show the plugin's human-facing name, not the
            # Python package/module path. PluginBase.plugin_name has an English fallback
            # derived from plugin_id, so it must not override Chinese Tools/Settings labels.
            display_name = _pick_plugin_display_name(
                item=item,
                plugin=plugin,
                plugin_id=effective_plugin_id,
                plugin_name=effective_plugin_name,
                contribution_label=contribution_label,
                static_meta=static_meta,
                entry_tail=entry_tail,
            )

            rows.append({
                **item,
                "entry": entry,
                "enabled": enabled,
                "display_name": display_name,
                "plugin_name": effective_plugin_name,
                "plugin_description": effective_plugin_description,
                "plugin_author": effective_plugin_author,
                "plugin_id": effective_plugin_id,
                "plugin_version": effective_plugin_version,
                "loaded": plugin is not None,
                "package_dir": str(package_dir) if package_dir is not None else "",
                "package_exists": bool(package_dir and (ROOT / package_dir).exists()),
                "settings_contributions": settings_meta,
                "tools_contributions": tools_meta,
                "static_plugin_labels": static_meta.get("labels") or [],
                "static_plugin_name": static_meta.get("plugin_name") or "",
                "has_settings": bool(settings_meta or static_meta.get("settings_count")),
                "has_tools": bool(tools_meta or static_meta.get("tools_count")),
            })
        return rows
    except Exception:
        traceback.print_exc()
        # Fallback: still surface the manifest instead of returning mock rows.
        return [
            {
                **x,
                "entry": str(x.get("entry") or ""),
                "enabled": x.get("enabled") is not False,
                "display_name": str(x.get("entry") or "").rpartition(":")[2] or str(x.get("entry") or ""),
                "loaded": False,
                "has_settings": False,
                "has_tools": False,
            }
            for x in _plugins_manifest()
            if isinstance(x, dict)
        ]


def _plugin_catalog_rows() -> dict[str, Any]:
    """Fetch the remote plugin catalog and annotate it with local install state."""
    from core.plugins.registry_catalog import (
        DEFAULT_REGISTRY_JSON_URL,
        fetch_registry_error_message,
        fetch_registry_plugins,
    )
    from core.plugins.registry_download import load_downloaded_repos, normalize_repo_slug

    try:
        records = fetch_registry_plugins(DEFAULT_REGISTRY_JSON_URL)
    except Exception as exc:
        return {
            "catalog": [],
            "error": fetch_registry_error_message(exc),
            "registry_url": DEFAULT_REGISTRY_JSON_URL,
        }

    local_plugins = _plugin_rows()
    local_by_entry = {
        _normalize_manifest_entry_light(str(row.get("entry") or "")): row
        for row in local_plugins
        if str(row.get("entry") or "").strip()
    }
    downloaded = load_downloaded_repos()
    rows: list[dict[str, Any]] = []
    for rec in records:
        repo_norm = normalize_repo_slug(rec.repo) if rec.repo.strip() else ""
        entry_norm = _normalize_manifest_entry_light(rec.entry) if rec.entry.strip() else ""
        local = local_by_entry.get(entry_norm)
        is_downloaded = bool(repo_norm and repo_norm in downloaded)
        is_installed = local is not None
        rows.append({
            "name": rec.name,
            "author": rec.author,
            "repo": rec.repo,
            "repo_norm": repo_norm,
            "description": rec.description,
            "entry": entry_norm,
            "github_url": rec.github_url() if rec.repo.strip() else "",
            "downloaded": is_downloaded,
            "installed": is_installed,
            "enabled": local.get("enabled") if local else None,
            "loaded": local.get("loaded") if local else False,
            "local_display_name": local.get("display_name") if local else "",
            "action_label": "更新" if is_downloaded or is_installed else "安装",
            "status_label": "已安装" if is_installed else ("已下载" if is_downloaded else "可安装"),
        })
    return {
        "catalog": rows,
        "error": "",
        "registry_url": DEFAULT_REGISTRY_JSON_URL,
    }


def _install_catalog_plugin(payload: dict[str, Any]) -> dict[str, Any]:
    """Download a registry plugin, install its requirements, and add it to plugins.yaml."""
    from core.plugins.github_bundle_update import install_github_plugin_under_plugins
    from core.plugins.plugin_requirements_install import install_plugin_requirements_txt
    from core.plugins.registry_download import mark_repo_downloaded, normalize_repo_slug

    repo = str(payload.get("repo") or "").strip()
    if not repo or repo.count("/") < 1:
        raise ValueError("缺少有效 GitHub 仓库（owner/repo）")
    name = str(payload.get("name") or "").strip() or repo.rpartition("/")[2]
    entry = _normalize_manifest_entry_light(str(payload.get("entry") or "").strip())
    overwrite = bool(payload.get("overwrite", False))

    dest = install_github_plugin_under_plugins(
        repo,
        catalog_display_name=name,
        ref_kind="latest",
        tag_name="",
        overwrite=overwrite,
        plugins_parent=ROOT / "plugins",
    )
    pip_code, pip_detail = install_plugin_requirements_txt(dest)
    if pip_code in {"pip_failed", "pip_timeout", "pip_exception"}:
        raise RuntimeError(f"插件依赖安装失败：{pip_code}{': ' + pip_detail if pip_detail else ''}")

    manifest_outcome = "skipped"
    if entry:
        manifest_outcome = _append_plugin_manifest_entry_if_missing_light(entry, enabled=True)
    mark_repo_downloaded(normalize_repo_slug(repo), manifest_entry=entry or None)
    return {
        "ok": True,
        "message": "插件已下载并写入清单，重启应用后完全生效",
        "plugin_dir": _path_relative_to_root(dest),
        "pip": pip_code,
        "manifest": manifest_outcome,
        "plugins": _plugin_rows(),
        **_plugin_catalog_rows(),
    }



PLUGIN_TEXT_EXTENSIONS = {".py", ".md", ".txt", ".yaml", ".yml", ".json", ".toml", ".ini", ".cfg", ".conf", ".env", ".example"}
PLUGIN_EDITABLE_EXTENSIONS = {".yaml", ".yml", ".json", ".toml", ".ini", ".cfg", ".conf", ".txt", ".env"}
PLUGIN_SKIP_DIRS = {".git", "__pycache__", ".venv", "venv", "node_modules", "dist", "build", ".mypy_cache", ".pytest_cache"}


def _path_relative_to_root(path: Path) -> str:
    try:
        return str(path.resolve().relative_to(ROOT.resolve()))
    except ValueError:
        return str(path.resolve())


def _is_inside(path: Path, base: Path) -> bool:
    try:
        path.resolve().relative_to(base.resolve())
        return True
    except ValueError:
        return False


def _safe_plugin_text_file(raw_path: str) -> Path | None:
    """Only allow editing plugin package/data text files from the Web plugin window."""
    raw = str(raw_path or "").strip()
    if not raw:
        return None
    p = Path(raw)
    if not p.is_absolute():
        p = ROOT / p
    try:
        resolved = p.resolve()
    except OSError:
        return None
    allowed_roots = [ROOT / "plugins", ROOT / "data" / "plugins", ROOT / "data" / "config" / "plugins.yaml"]
    allowed_files = {
        (ROOT / "data" / "config" / "plugins.yaml").resolve(),
        (ROOT / "data" / "chat_ui_theme.json").resolve(),
    }
    if resolved in allowed_files:
        return resolved
    if not any(_is_inside(resolved, base) for base in allowed_roots[:2]):
        return None
    if resolved.suffix.lower() not in PLUGIN_EDITABLE_EXTENSIONS:
        return None
    return resolved


def _read_text_file(path: Path, max_chars: int = 120_000) -> tuple[str, bool]:
    try:
        data = path.read_text(encoding="utf-8", errors="replace")
    except Exception as exc:
        return f"读取失败：{exc}", True
    truncated = len(data) > max_chars
    if truncated:
        data = data[:max_chars] + "\n\n…（文件较大，已截断预览；保存会覆盖当前文本，请谨慎。）"
    return data, truncated


def _summarize_text_file(path: Path, editable: bool) -> dict[str, Any]:
    text, truncated = _read_text_file(path)
    return {
        "path": _path_relative_to_root(path),
        "name": path.name,
        "suffix": path.suffix.lower(),
        "size": path.stat().st_size if path.exists() else 0,
        "editable": editable and not truncated,
        "truncated": truncated,
        "content": text,
    }


def _iter_plugin_files(base: Path, max_files: int = 160) -> list[Path]:
    if not base or not base.exists() or not base.is_dir():
        return []
    out: list[Path] = []
    for p in sorted(base.rglob("*")):
        if len(out) >= max_files:
            break
        if any(part in PLUGIN_SKIP_DIRS for part in p.parts):
            continue
        if not p.is_file():
            continue
        if p.suffix.lower() in PLUGIN_TEXT_EXTENSIONS or p.name.lower().startswith(("readme", "license", "requirements")):
            out.append(p)
    return out


def _plugin_data_dir_candidates(row: dict[str, Any]) -> list[Path]:
    """Return likely data/plugins roots for a plugin.

    Important: PluginManager uses ``plugin_id.replace("/", "_")`` and DOES NOT
    replace dots. Earlier Web bridge code converted dots to underscores, so
    ``com.shinsekai.moondream_vision`` became ``com_shinsekai_moondream_vision``
    and Moondream's real ``data/plugins/com.shinsekai.moondream_vision/config.json``
    was invisible.
    """
    candidates: list[Path] = []

    plugin_id = str(row.get("plugin_id") or "").strip()
    if plugin_id:
        candidates.append(ROOT / "data" / "plugins" / plugin_id.replace("/", "_"))

    package_dir = str(row.get("package_dir") or "").strip()
    if package_dir:
        pkg_name = Path(package_dir).name
        if pkg_name:
            candidates.append(ROOT / "data" / "plugins" / pkg_name)

    entry = str(row.get("entry") or "").strip()
    mod = entry.split(":", 1)[0].strip()
    if mod.startswith("plugins."):
        rest = mod[len("plugins."):]
        if rest:
            candidates.append(ROOT / "data" / "plugins" / rest.split(".", 1)[0])
            candidates.append(ROOT / "data" / "plugins" / rest)

    # Legacy/fallback candidates for older bridge builds that created underscored dirs.
    for raw in (plugin_id, row.get("display_name"), entry):
        value = str(raw or "").strip()
        if not value:
            continue
        safe = value.replace("/", "_").replace(":", "_").replace(".", "_")
        candidates.append(ROOT / "data" / "plugins" / safe)

    seen: set[str] = set()
    uniq: list[Path] = []
    for p in candidates:
        key = str(p)
        if key not in seen:
            seen.add(key)
            uniq.append(p)
    return uniq


def _ast_literal_value(node: Any) -> Any:
    import ast

    try:
        return ast.literal_eval(node)
    except Exception:
        return None


def _plugin_settings_ui_metadata(package_dir: Path | None) -> dict[str, Any]:
    """Extract human-facing labels from a plugin's PySide settings_tab.py.

    This keeps the Web panel focused on the plugin's own settings surface instead
    of exposing implementation files / manifest internals. It is intentionally
    static: no plugin imports, so heavy dependencies such as torch are not loaded.
    """
    out: dict[str, Any] = {
        "intro": [],
        "group_titles": [],
        "labels_by_attr": {},
        "placeholders_by_attr": {},
        "tooltips_by_attr": {},
    }
    if package_dir is None or not package_dir.exists():
        return out
    settings_py = package_dir / "settings_tab.py"
    if not settings_py.is_file():
        return out
    try:
        import ast
        tree = ast.parse(settings_py.read_text(encoding="utf-8"), filename=str(settings_py))
    except Exception:
        return out

    def const_text(node: Any) -> str:
        text = _const_str_from_ast(node)
        if text:
            return text
        import ast
        if isinstance(node, ast.BinOp) and isinstance(node.op, ast.Add):
            left = const_text(node.left)
            right = const_text(node.right)
            if left or right:
                return (left + right).strip()
        return ""

    def self_attr(node: Any) -> str:
        import ast
        if isinstance(node, ast.Attribute) and isinstance(node.value, ast.Name) and node.value.id == "self":
            return node.attr
        return ""

    def call_name(node: Any) -> str:
        import ast
        if isinstance(node, ast.Name):
            return node.id
        if isinstance(node, ast.Attribute):
            return node.attr
        return ""

    for node in ast.walk(tree):
        import ast
        if isinstance(node, ast.Assign) and node.targets:
            target_attr = self_attr(node.targets[0])
            if isinstance(node.value, ast.Call):
                cname = call_name(node.value.func)
                if cname == "QCheckBox" and target_attr and node.value.args:
                    text = const_text(node.value.args[0])
                    if text:
                        out["labels_by_attr"][target_attr] = text
                if cname == "QLabel" and node.value.args:
                    text = const_text(node.value.args[0])
                    if len(text) >= 50:
                        out["intro"].append(text)
                if cname == "QGroupBox" and node.value.args:
                    text = const_text(node.value.args[0])
                    if text:
                        out["group_titles"].append(text)
        if isinstance(node, ast.Call):
            fname = call_name(node.func)
            # fl.addRow("模型 ID:", self._model_id)
            if fname == "addRow" and len(node.args) >= 2:
                label = const_text(node.args[0])
                attr = self_attr(node.args[1])
                if label and attr:
                    out["labels_by_attr"][attr] = label.rstrip(":：")
            # self._field.setPlaceholderText("...") / setToolTip("...")
            if isinstance(node.func, ast.Attribute) and node.args:
                attr = self_attr(node.func.value)
                text = const_text(node.args[0])
                if attr and text:
                    if node.func.attr == "setPlaceholderText":
                        out["placeholders_by_attr"][attr] = text
                    elif node.func.attr == "setToolTip":
                        out["tooltips_by_attr"][attr] = text

    for key in ("intro", "group_titles"):
        seen: set[str] = set()
        deduped: list[str] = []
        for v in out[key]:
            sv = str(v or "").strip()
            if sv and sv not in seen:
                seen.add(sv)
                deduped.append(sv)
        out[key] = deduped
    return out


def _plugin_config_field_attr_name(field_name: str) -> str:
    """Map dataclass config fields to common self._xxx names in settings_tab.py."""
    aliases = {
        "motion_poll_sec": "motion_poll",
        "diff_threshold": "diff_thr",
        "mouse_move_percent": "mouse_pct",
        "interval_sec": "interval",
        "monitor_index": "monitor",
        "message_prefix": "prefix",
        "question_screen_diff": "q_screen_diff",
        "question_foreground": "q_foreground",
        "question_new_window": "q_new_window",
        "question_mouse": "q_mouse",
    }
    return aliases.get(field_name, field_name)


def _read_json_dict_utf8(path: Path) -> dict[str, Any]:
    if not path.is_file():
        return {}
    try:
        raw = json.loads(path.read_text(encoding="utf-8-sig"))
    except Exception:
        return {}
    return dict(raw) if isinstance(raw, dict) else {}


def _web_field(
    name: str,
    label: str,
    typ: str,
    default: Any,
    *,
    section: str = "",
    choices: list[Any] | None = None,
    labels: list[str] | None = None,
    help_text: str = "",
    placeholder: str = "",
    ui: str = "",
    min_value: int | float | None = None,
    max_value: int | float | None = None,
    step: int | float | None = None,
    multiline: bool = False,
) -> dict[str, Any]:
    field: dict[str, Any] = {
        "name": name,
        "type": typ,
        "default": default,
        "label": label,
    }
    if section:
        field["section"] = section
    if choices is not None:
        field["choices"] = choices
    if labels is not None:
        field["labels"] = labels
    if help_text:
        field["help"] = help_text
    if placeholder:
        field["placeholder"] = placeholder
    if ui:
        field["ui"] = ui
    if min_value is not None:
        field["min"] = min_value
    if max_value is not None:
        field["max"] = max_value
    if step is not None:
        field["step"] = step
    if multiline:
        field["multiline"] = True
    return field


def _plugin_web_schema_for_minimax_tts(package_dir: Path, preferred_data_dir: Path) -> dict[str, Any]:
    defaults = {
        "model": "speech-2.8-hd",
        "default_voice_id": "",
        "language_boost": "auto",
        "audio_format": "wav",
        "sample_rate": 32000,
        "bitrate": 128000,
        "channel": 1,
        "speed": 1.0,
        "vol": 1.0,
        "pitch": 0,
        "emotion": "",
        "auto_clone_from_reference": False,
        "paragraph_split_enabled": True,
        "request_timeout": 120,
        "need_noise_reduction": False,
        "need_volume_normalization": True,
        "voice_cache_path": "cache/audio/minimax_voice_cache.json",
        "voice_id_map": {},
        "voice_id_versions": {},
    }
    defaults.update(_read_json_dict_utf8(package_dir / "config.json"))
    cfg_path = preferred_data_dir / "config.json"
    values = dict(defaults)
    try:
        from plugins.minimax_tts import state as minimax_state

        loaded = minimax_state.load_plugin_config(preferred_data_dir)
        if isinstance(loaded, dict):
            values.update({k: v for k, v in loaded.items() if v not in (None, "", {}, [])})
    except Exception:
        values.update(_read_json_dict_utf8(cfg_path))

    return {
        "class_name": "MinimaxTtsSettingsWidget",
        "kind": "minimax_tts",
        "title": "MiniMax TTS",
        "intro": [
            "本面板按 plugins/minimax_tts/settings.py 的真实设置页生成；API Key 和 Base URL 仍在主菜单 API 页保存。",
            "这里保存模型、合成参数、Paragraph、默认 voice_id 和角色 voice_id 绑定。上传参考音频仍需使用原生面板。",
        ],
        "path": _path_relative_to_root(cfg_path),
        "exists": cfg_path.is_file(),
        "format": "json",
        "fields": [
            _web_field("model", "模型", "str", defaults["model"], section="模型与兜底声线", choices=[
                "speech-2.8-hd", "speech-2.8-turbo", "speech-2.6-hd",
                "speech-2.6-turbo", "speech-02-hd", "speech-02-turbo",
            ]),
            _web_field("default_voice_id", "无角色兜底 voice_id", "str", "", section="模型与兜底声线", placeholder="未匹配角色时使用的保底 voice_id"),
            _web_field("language_boost", "语言增强", "str", "auto", section="合成参数", choices=["auto", "Japanese", "Chinese", "Chinese,Yue", "English"]),
            _web_field("audio_format", "音频格式", "str", "wav", section="合成参数", choices=["wav", "mp3", "flac"]),
            _web_field("sample_rate", "采样率", "int", 32000, section="合成参数", min_value=8000, max_value=48000, step=1000),
            _web_field("bitrate", "比特率", "int", 128000, section="合成参数", min_value=32000, max_value=320000, step=16000),
            _web_field("channel", "声道", "int", 1, section="合成参数", choices=[1, 2], labels=["单声道", "双声道"]),
            _web_field("speed", "语速", "float", 1.0, section="合成参数", min_value=0.5, max_value=2.0, step=0.05),
            _web_field("vol", "音量", "float", 1.0, section="合成参数", min_value=0.1, max_value=10.0, step=0.05),
            _web_field("pitch", "音高", "int", 0, section="合成参数", min_value=-12, max_value=12, step=1),
            _web_field("emotion", "默认情绪", "str", "", section="合成参数", choices=["", "happy", "sad", "angry", "fearful", "disgusted", "surprised", "neutral"], labels=["不固定", "happy", "sad", "angry", "fearful", "disgusted", "surprised", "neutral"]),
            _web_field("auto_clone_from_reference", "未找到 voice_id 时，从角色参考音频自动克隆", "bool", False, section="合成参数"),
            _web_field("paragraph_split_enabled", "Paragraph：按段落整段生成（不按标点切分）", "bool", True, section="合成参数"),
            _web_field("request_timeout", "请求超时", "int", 120, section="合成参数", min_value=5, max_value=600, step=1),
            _web_field("need_noise_reduction", "克隆时启用降噪", "bool", False, section="角色参考音频上传"),
            _web_field("need_volume_normalization", "克隆时音量归一", "bool", True, section="角色参考音频上传"),
            _web_field("voice_cache_path", "自动克隆缓存", "str", defaults["voice_cache_path"], section="角色参考音频上传"),
            _web_field("voice_id_map", "角色 voice_id 映射", "json", {}, section="角色 voice_id", ui="textarea", multiline=True, help_text='JSON 对象，例如 {"角色名": "voice_id"}。'),
            _web_field("voice_id_versions", "voice_id 版本记录", "json", {}, section="角色 voice_id", ui="textarea", multiline=True, help_text="原生面板上传/导入产生的版本记录；通常无需手动改。"),
        ],
        "values": values,
    }


def _plugin_web_schema_for_chat_ui_theme(package_dir: Path) -> dict[str, Any]:
    _ = package_dir
    cfg_path = ROOT / "data" / "chat_ui_theme.json"
    values = {
        "primary": "#fffcf8",
        "text": "#5e5e5e",
        "border": "#ffd0c2",
        "accent": "#ffbda8",
        "radius": 16,
        "panel_alpha": 0.92,
        "pattern_path": "",
        "pattern_opacity": 1.0,
        "pattern_dialog": False,
        "pattern_input": False,
        "pattern_options": False,
        "pattern_numeric": False,
    }
    return {
        "class_name": "build_chat_ui_theme_settings",
        "kind": "chat_ui_theme_builder",
        "title": "聊天外观",
        "intro": [
            "本面板按 plugins/chat_ui_customize/settings_widget.py 的真实设置页生成，用调色板、圆角和可选印花生成 data/chat_ui_theme.json。",
            "保存会重新生成正式主题 JSON；复杂的实时预览和本地图片选择仍可回原生面板使用。",
        ],
        "path": _path_relative_to_root(cfg_path),
        "exists": cfg_path.is_file(),
        "format": "json",
        "fields": [
            _web_field("primary", "主色（面板浅底）", "color", values["primary"], section="可视化配色", ui="color"),
            _web_field("text", "主文字色", "color", values["text"], section="可视化配色", ui="color"),
            _web_field("border", "边框色", "color", values["border"], section="可视化配色", ui="color"),
            _web_field("accent", "强调色（发送键、Busy、录音激活等）", "color", values["accent"], section="可视化配色", ui="color"),
            _web_field("radius", "圆角（px）", "int", values["radius"], section="圆角与面板不透明度", min_value=8, max_value=28, step=1),
            _web_field("panel_alpha", "面板不透明度", "float", values["panel_alpha"], section="圆角与面板不透明度", min_value=0.5, max_value=0.98, step=0.01),
            _web_field("pattern_path", "印花图片路径", "str", "", section="印花 / 纹理背景", placeholder="可选；绝对路径或项目内相对路径"),
            _web_field("pattern_opacity", "印花透明度", "float", values["pattern_opacity"], section="印花 / 纹理背景", min_value=0.0, max_value=1.0, step=0.05),
            _web_field("pattern_dialog", "叠加到对白气泡", "bool", False, section="印花 / 纹理背景"),
            _web_field("pattern_input", "叠加到输入框", "bool", False, section="印花 / 纹理背景"),
            _web_field("pattern_options", "叠加到选项区外框", "bool", False, section="印花 / 纹理背景"),
            _web_field("pattern_numeric", "叠加到数值标签", "bool", False, section="印花 / 纹理背景"),
        ],
        "values": values,
    }


def _known_plugin_web_config_schema(package_dir: Path | None, preferred_data_dir: Path) -> dict[str, Any] | None:
    if package_dir is None or not package_dir.exists():
        return None
    name = package_dir.name
    if name == "minimax_tts":
        return _plugin_web_schema_for_minimax_tts(package_dir, preferred_data_dir)
    if name == "chat_ui_customize":
        return _plugin_web_schema_for_chat_ui_theme(package_dir)
    return None


def _plugin_web_config_schema(package_dir: Path | None, preferred_data_dir: Path) -> dict[str, Any] | None:
    """Generate the Web version of the plugin's own settings panel.

    Reads config_model.py for fields/defaults and settings_tab.py for Chinese labels,
    help text, placeholders and the plugin's own introductory copy.
    """
    special = _known_plugin_web_config_schema(package_dir, preferred_data_dir)
    if special is not None:
        return special
    if package_dir is None or not package_dir.exists():
        return None
    cfg_py = package_dir / "config_model.py"
    if not cfg_py.is_file():
        return None
    try:
        import ast
        tree = ast.parse(cfg_py.read_text(encoding="utf-8"), filename=str(cfg_py))
    except Exception:
        return None

    ui_meta = _plugin_settings_ui_metadata(package_dir)

    classes: list[dict[str, Any]] = []
    for node in ast.walk(tree):
        if not isinstance(node, ast.ClassDef):
            continue
        is_dataclass = any(
            (isinstance(d, ast.Name) and d.id == "dataclass")
            or (isinstance(d, ast.Attribute) and d.attr == "dataclass")
            for d in node.decorator_list
        )
        if not is_dataclass:
            continue
        fields: list[dict[str, Any]] = []
        pending_doc_for: str | None = None
        for item in node.body:
            if isinstance(item, ast.AnnAssign) and isinstance(item.target, ast.Name):
                name = item.target.id
                typ = ""
                try:
                    typ = ast.unparse(item.annotation)
                except Exception:
                    typ = ""
                default = _ast_literal_value(item.value) if item.value is not None else None
                attr_name = _plugin_config_field_attr_name(name)
                label = (ui_meta.get("labels_by_attr") or {}).get(attr_name, name)
                placeholder = (ui_meta.get("placeholders_by_attr") or {}).get(attr_name, "")
                tooltip = (ui_meta.get("tooltips_by_attr") or {}).get(attr_name, "")
                field: dict[str, Any] = {
                    "name": name,
                    "type": typ,
                    "default": default,
                    "label": label,
                    "placeholder": placeholder,
                    "help": tooltip,
                }
                if name == "device":
                    field["choices"] = ["auto", "cuda", "mps", "cpu"]
                    field["labels"] = ["自动", "CUDA", "Apple MPS", "CPU"]
                elif name == "quantization":
                    field["choices"] = ["none", "int8", "int4"]
                    field["labels"] = ["无（浮点）", "INT8", "INT4（NF4）"]
                fields.append(field)
                pending_doc_for = name
            elif isinstance(item, ast.Expr) and isinstance(item.value, ast.Constant) and isinstance(item.value.value, str) and pending_doc_for:
                for f in reversed(fields):
                    if f["name"] == pending_doc_for and not f.get("help"):
                        f["help"] = item.value.value.strip()
                        break
                pending_doc_for = None
        if fields:
            classes.append({"name": node.name, "fields": fields})

    if not classes:
        return None
    cls = next((c for c in classes if c["name"].lower().endswith("config")), classes[0])

    config_name = "config.json"
    for node in ast.walk(tree):
        if isinstance(node, ast.FunctionDef) and node.name == "default_config_path":
            for sub in ast.walk(node):
                if isinstance(sub, ast.Constant) and isinstance(sub.value, str) and sub.value.endswith((".json", ".yaml", ".yml", ".toml", ".ini", ".cfg")):
                    config_name = sub.value
                    break

    cfg_path = preferred_data_dir / config_name
    values = {f["name"]: f.get("default") for f in cls["fields"]}
    if cfg_path.is_file():
        try:
            if cfg_path.suffix.lower() == ".json":
                loaded = json.loads(cfg_path.read_text(encoding="utf-8"))
            else:
                import yaml
                loaded = yaml.safe_load(cfg_path.read_text(encoding="utf-8")) or {}
            if isinstance(loaded, dict):
                values.update(loaded)
        except Exception:
            traceback.print_exc()

    return {
        "class_name": cls["name"],
        "title": (ui_meta.get("group_titles") or [""])[0] or "插件设置",
        "intro": ui_meta.get("intro") or [],
        "path": _path_relative_to_root(cfg_path),
        "exists": cfg_path.is_file(),
        "fields": cls["fields"],
        "values": values,
        "format": cfg_path.suffix.lower().lstrip(".") or "json",
    }


def _plugin_web_detail(entry: str) -> dict[str, Any]:
    """Best-effort Web-compatible plugin settings/details by reading package and data files."""
    entry = str(entry or "").strip()
    rows = _plugin_rows()
    row = next((r for r in rows if str(r.get("entry") or "").strip() == entry), None)
    if row is None:
        row = {"entry": entry, "enabled": True, "display_name": entry.rpartition(":")[2] or entry}

    package_dir = None
    rel = str(row.get("package_dir") or "").strip()
    if rel:
        candidate = (ROOT / rel).resolve()
        if _is_inside(candidate, ROOT / "plugins") and candidate.exists():
            package_dir = candidate

    package_files = _iter_plugin_files(package_dir) if package_dir else []
    readme_file = next((p for p in package_files if p.name.lower().startswith("readme")), None)
    requirements_file = next((p for p in package_files if p.name.lower() == "requirements.txt"), None)
    pyproject_file = next((p for p in package_files if p.name.lower() == "pyproject.toml"), None)

    package_config_files = [
        p for p in package_files
        if p.suffix.lower() in PLUGIN_EDITABLE_EXTENSIONS
        and ("config" in p.name.lower() or p.suffix.lower() in {".yaml", ".yml", ".json", ".toml", ".ini", ".cfg", ".conf", ".env"})
    ][:40]

    data_dirs = [p for p in _plugin_data_dir_candidates(row) if p.exists() and p.is_dir()]
    data_files: list[Path] = []
    for d in data_dirs:
        data_files.extend(_iter_plugin_files(d, max_files=80))
    data_config_files = [p for p in data_files if p.suffix.lower() in PLUGIN_EDITABLE_EXTENSIONS][:80]

    # Include a not-yet-existing preferred data directory so the UI can show where plugin data should live.
    preferred_data_dir = _plugin_data_dir_candidates(row)[0] if _plugin_data_dir_candidates(row) else ROOT / "data" / "plugins"
    web_config_schema = _plugin_web_config_schema(package_dir, preferred_data_dir)

    editable_files = []
    seen_file_paths: set[str] = set()

    # If a plugin declares a dataclass config but the config file has not been created yet,
    # expose a virtual editable config.json so the Web panel is still usable.
    if web_config_schema:
        cfg_path = ROOT / str(web_config_schema.get("path") or "")
        default_content = json.dumps(web_config_schema.get("values") or {}, ensure_ascii=False, indent=2)
        if cfg_path.is_file():
            editable_files.append(_summarize_text_file(cfg_path, editable=True))
            seen_file_paths.add(str(cfg_path.resolve()))
        else:
            editable_files.append({
                "path": str(web_config_schema.get("path") or ""),
                "name": Path(str(web_config_schema.get("path") or "config.json")).name,
                "suffix": ".json",
                "size": 0,
                "editable": True,
                "truncated": False,
                "virtual": True,
                "content": default_content,
            })

    for p in [*data_config_files, *package_config_files]:
        key = str(p.resolve())
        if key in seen_file_paths:
            continue
        seen_file_paths.add(key)
        editable_files.append(_summarize_text_file(p, editable=True))

    readme = None
    if readme_file is not None:
        text, truncated = _read_text_file(readme_file, max_chars=80_000)
        readme = {"path": _path_relative_to_root(readme_file), "content": text, "truncated": truncated}

    requirements = None
    if requirements_file is not None:
        text, truncated = _read_text_file(requirements_file, max_chars=40_000)
        requirements = {"path": _path_relative_to_root(requirements_file), "content": text, "truncated": truncated}

    pyproject = None
    if pyproject_file is not None:
        text, truncated = _read_text_file(pyproject_file, max_chars=40_000)
        pyproject = {"path": _path_relative_to_root(pyproject_file), "content": text, "truncated": truncated}

    return {
        "manifest": row,
        "package": {
            "dir": _path_relative_to_root(package_dir) if package_dir else "",
            "exists": bool(package_dir and package_dir.exists()),
            "files": [
                {
                    "path": _path_relative_to_root(p),
                    "name": p.name,
                    "suffix": p.suffix.lower(),
                    "size": p.stat().st_size,
                }
                for p in package_files[:160]
            ],
            "readme": readme,
            "requirements": requirements,
            "pyproject": pyproject,
        },
        "data": {
            "preferred_dir": _path_relative_to_root(preferred_data_dir),
            "dirs": [_path_relative_to_root(p) for p in data_dirs],
            "files": [
                {"path": _path_relative_to_root(p), "name": p.name, "suffix": p.suffix.lower(), "size": p.stat().st_size}
                for p in data_files[:160]
            ],
        },
        "editable_files": editable_files,
        "web_config_schema": web_config_schema,
        "settings_contributions": row.get("settings_contributions") or [],
        "tools_contributions": row.get("tools_contributions") or [],
        "compatibility": {
            "web_native": bool(editable_files or readme or package_files),
            "qt_widget_settings": bool(row.get("has_settings")),
            "note": "已优先使用 Web 插件窗口读取插件包与配置文件；PySide QWidget 设置页仅作为可选 fallback。",
        },
    }


def _hex_color(value: Any, fallback: str) -> str:
    text = str(value or "").strip()
    if re.fullmatch(r"#[0-9A-Fa-f]{6}", text):
        return text
    return fallback


def _as_web_bool(value: Any, default: bool = False) -> bool:
    if isinstance(value, bool):
        return value
    if value is None:
        return default
    if isinstance(value, str):
        lowered = value.strip().lower()
        if lowered in {"1", "true", "yes", "on", "是", "启用"}:
            return True
        if lowered in {"0", "false", "no", "off", "否", "关闭"}:
            return False
    return bool(value)


def _as_web_float(value: Any, default: float, *, min_value: float | None = None, max_value: float | None = None) -> float:
    try:
        out = float(value)
    except (TypeError, ValueError):
        out = default
    if min_value is not None:
        out = max(min_value, out)
    if max_value is not None:
        out = min(max_value, out)
    return out


def _as_web_int(value: Any, default: int, *, min_value: int | None = None, max_value: int | None = None) -> int:
    try:
        out = int(value)
    except (TypeError, ValueError):
        out = default
    if min_value is not None:
        out = max(min_value, out)
    if max_value is not None:
        out = min(max_value, out)
    return out


def _save_chat_ui_theme_builder_config(values: dict[str, Any]) -> dict[str, Any]:
    from PySide6.QtGui import QColor

    from plugins.chat_ui_customize.theme_builder import build_theme_dict
    from ui.chat_ui.theme_chrome import clear_chat_chrome_theme_cache

    def color(key: str, fallback: str) -> QColor:
        c = QColor(_hex_color(values.get(key), fallback))
        if not c.isValid():
            c = QColor(fallback)
        return c

    pattern_value = str(values.get("pattern_path") or "").strip()
    pattern_path: Path | None = None
    if pattern_value:
        p = Path(pattern_value)
        if not p.is_absolute():
            p = ROOT / p
        pattern_path = p

    data = build_theme_dict(
        primary=color("primary", "#fffcf8"),
        text=color("text", "#5e5e5e"),
        border=color("border", "#ffd0c2"),
        accent=color("accent", "#ffbda8"),
        panel_alpha=_as_web_float(values.get("panel_alpha"), 0.92, min_value=0.5, max_value=0.98),
        radius=_as_web_int(values.get("radius"), 16, min_value=8, max_value=28),
        pattern_path=pattern_path,
        pattern_opacity=_as_web_float(values.get("pattern_opacity"), 1.0, min_value=0.0, max_value=1.0),
        pattern_dialog=_as_web_bool(values.get("pattern_dialog"), False),
        pattern_input=_as_web_bool(values.get("pattern_input"), False),
        pattern_options=_as_web_bool(values.get("pattern_options"), False),
        pattern_numeric=_as_web_bool(values.get("pattern_numeric"), False),
    )
    target = ROOT / "data" / "chat_ui_theme.json"
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    try:
        clear_chat_chrome_theme_cache()
    except Exception:
        traceback.print_exc()
    return {
        "ok": True,
        "message": f"聊天外观主题已重新生成：{_path_relative_to_root(target)}",
        "file": _summarize_text_file(target, editable=True),
    }


def _save_minimax_tts_web_config(values: dict[str, Any]) -> dict[str, Any]:
    from plugins.minimax_tts import state as minimax_state

    root = ROOT / "data" / "plugins" / "com.shinsekai.minimax_tts"
    cleaned = dict(values)
    cleaned.pop("__web_schema_kind", None)
    minimax_state.save_plugin_config(root, cleaned)
    target = root / "config.json"
    return {
        "ok": True,
        "message": f"MiniMax TTS 插件设置已保存：{_path_relative_to_root(target)}",
        "file": _summarize_text_file(target, editable=True),
    }


def _maybe_save_plugin_web_config(target: Path, content: str) -> dict[str, Any] | None:
    try:
        raw = json.loads(content)
    except Exception:
        return None
    if not isinstance(raw, dict):
        return None
    kind = str(raw.get("__web_schema_kind") or "").strip()
    if not kind:
        return None
    values = dict(raw)
    values.pop("__web_schema_kind", None)
    if kind == "chat_ui_theme_builder":
        if target.resolve() != (ROOT / "data" / "chat_ui_theme.json").resolve():
            raise ValueError("聊天外观只能保存到 data/chat_ui_theme.json")
        return _save_chat_ui_theme_builder_config(values)
    if kind == "minimax_tts":
        expected = (ROOT / "data" / "plugins" / "com.shinsekai.minimax_tts" / "config.json").resolve()
        if target.resolve() != expected:
            raise ValueError("MiniMax TTS 只能保存到 data/plugins/com.shinsekai.minimax_tts/config.json")
        return _save_minimax_tts_web_config(values)
    return None

def _read_mcp_config() -> dict[str, Any]:
    try:
        from llm.tools.mcp_config_file import DEFAULT_MCP_CONFIG_PATH, read_mcp_config

        cfg = read_mcp_config(DEFAULT_MCP_CONFIG_PATH)
        cfg["path"] = str((ROOT / DEFAULT_MCP_CONFIG_PATH).resolve())
        return cfg
    except Exception:
        traceback.print_exc()
        return {"enabled": True, "default_call_timeout": 300.0, "servers": [], "error": "MCP config load failed"}


def _write_mcp_config(data: dict[str, Any]) -> dict[str, Any]:
    from llm.tools.mcp_config_file import DEFAULT_MCP_CONFIG_PATH, read_mcp_config, write_mcp_config

    current = read_mcp_config(DEFAULT_MCP_CONFIG_PATH)
    payload = {
        "enabled": bool(data.get("enabled", current.get("enabled", True))),
        "default_call_timeout": float(data.get("default_call_timeout", current.get("default_call_timeout", 300.0))),
        "servers": data.get("servers") if isinstance(data.get("servers"), list) else current.get("servers", []),
    }
    write_mcp_config(payload, DEFAULT_MCP_CONFIG_PATH)
    payload["path"] = str((ROOT / DEFAULT_MCP_CONFIG_PATH).resolve())
    return payload


def _preview_mcp_tools(config: dict[str, Any] | None = None) -> list[dict[str, Any]]:
    import tempfile
    import yaml
    from llm.tools.mcp_tool_setup import preview_mcp_tools_from_config

    cfg = config if config is not None else _read_mcp_config()
    path: Path | None = None
    try:
        with tempfile.NamedTemporaryFile(mode="w", suffix=".yaml", delete=False, encoding="utf-8") as tf:
            yaml.safe_dump(
                {
                    "enabled": bool(cfg.get("enabled", True)),
                    "default_call_timeout": float(cfg.get("default_call_timeout", 300.0)),
                    "servers": cfg.get("servers") if isinstance(cfg.get("servers"), list) else [],
                },
                tf,
                allow_unicode=True,
                default_flow_style=False,
                sort_keys=False,
            )
            path = Path(tf.name)
        rows = preview_mcp_tools_from_config(path)
        return [x for x in rows if isinstance(x, dict)]
    finally:
        if path is not None:
            try:
                path.unlink(missing_ok=True)
            except OSError:
                pass


def _reload_mcp_tools_after_write() -> str:
    try:
        from llm.tools.mcp_config_file import DEFAULT_MCP_CONFIG_PATH
        from llm.tools.mcp_tool_setup import reload_mcp_tools_from_config
        from llm.tools.tool_manager import ToolManager

        reload_mcp_tools_from_config(ToolManager(), DEFAULT_MCP_CONFIG_PATH)
        return ""
    except ImportError:
        return "配置已保存，但当前环境缺少 mcp 包；安装 mcp 后才能连接服务。"
    except Exception as exc:
        traceback.print_exc()
        return f"配置已保存，但重新注册 MCP 工具失败：{exc}"


def _open_path(path: Path) -> None:
    path = path.resolve()
    if platform.system() == "Darwin":
        subprocess.Popen(["open", str(path)], cwd=str(ROOT))
    elif platform.system() == "Windows":
        os.startfile(str(path))  # type: ignore[attr-defined]
    else:
        subprocess.Popen(["xdg-open", str(path)], cwd=str(ROOT))


def _frontend_dir() -> Path:
    return ROOT / "frontend"


def _safe_static_path(path: str) -> Path | None:
    frontend = _frontend_dir().resolve()
    if path in ("", "/"):
        candidate = frontend / "index.html"
    else:
        # 去掉 query 后的前导斜杠，只允许 frontend/ 内文件。
        relative = path.lstrip("/")
        candidate = (frontend / relative).resolve()
    try:
        candidate.relative_to(frontend)
    except ValueError:
        return None
    return candidate if candidate.is_file() else None


def _safe_project_file(raw_path: str) -> Path | None:
    raw = str(raw_path or "").strip()
    if not raw:
        return None
    p = Path(raw)
    if not p.is_absolute():
        p = ROOT / p
    try:
        resolved = p.resolve()
    except OSError:
        return None
    try:
        resolved.relative_to(ROOT.resolve())
    except ValueError:
        # 不把项目外部任意文件暴露给 WebView。
        return None
    return resolved if resolved.is_file() else None


def _replace_or_append_model(items: list[Any], incoming: dict[str, Any], model_cls, key: str = "name") -> list[Any]:
    name = str(incoming.get(key, "")).strip()
    if not name:
        raise ValueError(f"{key} is required")
    normalized = []
    replaced = False
    for item in items:
        data = item.model_dump(mode="json", by_alias=True) if hasattr(item, "model_dump") else dict(item)
        if str(data.get(key, "")).lower() == name.lower():
            data.update(incoming)
            normalized.append(model_cls.model_validate(data))
            replaced = True
        else:
            normalized.append(item)
    if not replaced:
        normalized.append(model_cls.model_validate(incoming))
    return normalized


class ShinsekaiApiHandler(BaseHTTPRequestHandler):
    server_version = "ShinsekaiFrontendApi/1.0"

    def _send(self, status: int, payload: Any) -> None:
        body = json.dumps(_json_safe(payload), ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET,POST,PUT,DELETE,OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Accept")
        self.end_headers()
        self.wfile.write(body)

    def _send_static(self, file_path: Path) -> None:
        ctype, _ = mimetypes.guess_type(str(file_path))
        if file_path.suffix == ".js":
            ctype = "text/javascript"
        elif file_path.suffix == ".css":
            ctype = "text/css"
        elif file_path.suffix == ".html":
            ctype = "text/html"
        body = file_path.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", f"{ctype or 'application/octet-stream'}; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _send_file_bytes(self, file_path: Path) -> None:
        ctype, _ = mimetypes.guess_type(str(file_path))
        body = file_path.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", ctype or "application/octet-stream")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _ok(self, payload: Any | None = None) -> None:
        self._send(200, payload if payload is not None else {"ok": True})

    def _error(self, status: int, message: str, *, detail: Any | None = None) -> None:
        self._send(status, {"ok": False, "error": message, "detail": detail})

    def _body(self) -> dict[str, Any]:
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0:
            return {}
        raw = self.rfile.read(length).decode("utf-8")
        if not raw.strip():
            return {}
        data = json.loads(raw)
        if not isinstance(data, dict):
            raise ValueError("JSON body must be an object")
        return data

    def do_OPTIONS(self) -> None:
        self._send(204, {})

    def do_GET(self) -> None:
        try:
            path = urlparse(self.path).path
            cm = _config_manager()

            if path == "/api/health":
                return self._ok({"ok": True, "version": cm.version})

            if path == "/api/assets":
                qs = parse_qs(urlparse(self.path).query)
                raw = qs.get("path", [""])[0]
                asset = _safe_project_file(raw)
                if asset is None:
                    return self._error(404, "资源文件不存在或不允许访问", detail={"path": raw})
                return self._send_file_bytes(asset)

            if path == "/api/app-state":
                api_payload = _json_safe(cm.config.api_config)
                provider_raw = str(api_payload.get("llm_provider") or "") if isinstance(api_payload, dict) else ""
                provider_effective = _normalize_llm_provider_name(provider_raw)
                if isinstance(api_payload, dict):
                    api_payload["llm_provider_raw"] = provider_raw
                    api_payload["llm_provider_effective"] = provider_effective
                    api_payload["llm_provider"] = provider_effective
                    api_payload["llm_model_current"] = _provider_map_value(api_payload.get("llm_model"), provider_effective)
                    api_payload["llm_api_key_current"] = _provider_map_value(api_payload.get("llm_api_key"), provider_effective)
                return self._ok({
                    "version": cm.version,
                    "api_config": api_payload,
                    "system_config": cm.config.system_config,
                    "llm_providers": _llm_provider_rows(),
                    "characters": cm.config.characters,
                    "backgrounds": cm.config.background_list,
                    "templates": self._list_templates(),
                    "histories": self._list_histories(),
                    "plugins": _plugin_rows(),
                    "mcp_config": _read_mcp_config(),
                })

            if path == "/api/llm/providers":
                return self._ok({"providers": _llm_provider_rows()})

            if path == "/api/config/api":
                api_payload = _json_safe(cm.config.api_config)
                if isinstance(api_payload, dict):
                    raw = str(api_payload.get("llm_provider") or "")
                    effective = _normalize_llm_provider_name(raw)
                    api_payload["llm_provider_raw"] = raw
                    api_payload["llm_provider_effective"] = effective
                    api_payload["llm_provider"] = effective
                    api_payload["llm_model_current"] = _provider_map_value(api_payload.get("llm_model"), effective)
                    api_payload["llm_api_key_current"] = _provider_map_value(api_payload.get("llm_api_key"), effective)
                    api_payload["llm_providers"] = _llm_provider_rows()
                return self._ok(api_payload)

            if path == "/api/config/system":
                return self._ok(cm.config.system_config)

            if path == "/api/characters":
                return self._ok({"characters": cm.config.characters})

            if path == "/api/backgrounds":
                return self._ok({"backgrounds": cm.config.background_list})

            if path == "/api/templates":
                return self._ok({"templates": self._list_templates()})

            if path == "/api/histories":
                return self._ok({"histories": self._list_histories()})

            if path == "/api/launch/status":
                return self._ok(self._launch_status())

            if path.startswith("/api/templates/"):
                name = unquote(path.removeprefix("/api/templates/"))
                return self._load_template(name)

            if path == "/api/plugins":
                return self._ok({"plugins": _plugin_rows()})

            if path == "/api/plugins/catalog":
                return self._ok(_plugin_catalog_rows())

            if path == "/api/plugins/web-detail":
                qs = parse_qs(urlparse(self.path).query)
                entry = qs.get("entry", [""])[0]
                return self._ok({"ok": True, "plugin": _plugin_web_detail(entry)})

            if path == "/api/mcp":
                return self._ok({"mcp_config": _read_mcp_config()})

            if path == "/api/mcp/tools":
                return self._ok({"tools": _preview_mcp_tools()})

            static_file = _safe_static_path(path)
            if static_file is not None:
                return self._send_static(static_file)

            return self._error(404, f"Unknown endpoint: {path}")
        except Exception as exc:
            traceback.print_exc()
            return self._error(500, str(exc))

    def do_PUT(self) -> None:
        try:
            path = urlparse(self.path).path
            body = self._body()
            cm = _config_manager()

            if path == "/api/config/api":
                return self._save_api_config(body)

            if path == "/api/config/system":
                return self._save_system_config(body)

            if path == "/api/config/adapter-extra":
                return self._save_adapter_extra(body)

            if path == "/api/plugins/manifest-row":
                return self._save_plugin_manifest_row(body)

            if path == "/api/plugins/web-file":
                raw_path = str(body.get("path") or "").strip()
                content = str(body.get("content") or "")
                target = _safe_plugin_text_file(raw_path)
                if target is None:
                    return self._error(400, "不允许编辑该文件；Web 插件窗口只允许编辑插件包、data/plugins/、plugins.yaml 与受支持的插件数据文件", detail={"path": raw_path})
                special = _maybe_save_plugin_web_config(target, content)
                if special is not None:
                    return self._ok(special)
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_text(content, encoding="utf-8")
                return self._ok({"ok": True, "message": f"插件文件已保存：{_path_relative_to_root(target)}", "file": _summarize_text_file(target, editable=True)})

            if path.startswith("/api/mcp/servers/"):
                index = int(unquote(path.removeprefix("/api/mcp/servers/")))
                return self._save_mcp_server(index, body)

            if path == "/api/mcp":
                cfg = _write_mcp_config(body)
                warning = _reload_mcp_tools_after_write()
                return self._ok({"ok": True, "message": warning or "MCP 配置已保存并应用", "mcp_config": cfg, "warning": warning})

            if path.startswith("/api/characters/"):
                name = unquote(path.removeprefix("/api/characters/"))
                body.setdefault("name", name)
                from config.schema import Character

                cm.config.characters = _replace_or_append_model(cm.config.characters, body, Character)
                cm.save_characters_config()
                return self._ok({"ok": True, "message": "人物已保存", "character": body})

            if path.startswith("/api/backgrounds/"):
                name = unquote(path.removeprefix("/api/backgrounds/"))
                body.setdefault("name", name)
                from config.schema import Background

                cm.config.background_list = _replace_or_append_model(cm.config.background_list, body, Background)
                cm.save_background_config()
                return self._ok({"ok": True, "message": "场景已保存", "background": body})

            return self._error(404, f"Unknown endpoint: {path}")
        except Exception as exc:
            traceback.print_exc()
            return self._error(500, str(exc))

    def do_POST(self) -> None:
        try:
            path = urlparse(self.path).path
            body = self._body()

            if path == "/api/services/test":
                # 目前只做配置形态校验；真实 LLM ping 可以后续接入各 adapter 的轻量请求。
                body["llm_provider"] = _normalize_llm_provider_name(body.get("llm_provider"))
                required = ["llm_provider", "llm_model", "base_url"]
                missing = [k for k in required if not str(body.get(k, "")).strip()]
                if missing:
                    return self._error(400, "缺少必要字段", detail={"missing": missing})
                supported = _supported_llm_provider_ids()
                if body["llm_provider"] not in supported:
                    return self._error(400, "不支持的 LLM 供应商", detail={"provider": body["llm_provider"], "supported": sorted(supported)})
                return self._ok({"ok": True, "message": f"配置字段完整，后端将使用 {body['llm_provider']} 适配器"})

            if path == "/api/templates":
                return self._save_template(body)

            if path == "/api/templates/generate":
                return self._generate_template(body)

            if path == "/api/launch":
                return self._launch(body)

            if path == "/api/launch/resume":
                return self._resume_launch()

            if path == "/api/launch/stop":
                from ui.settings_ui.services.chat_template_handlers import stop_chat

                return self._ok({"ok": True, "message": stop_chat()})

            if path == "/api/open-path":
                return self._open_project_path(body)

            if path == "/api/mcp/servers":
                return self._add_mcp_server(body)

            if path == "/api/mcp/global/toggle":
                cfg = _read_mcp_config()
                cfg["enabled"] = bool(body.get("enabled", not bool(cfg.get("enabled", True))))
                cfg = _write_mcp_config(cfg)
                warning = _reload_mcp_tools_after_write()
                return self._ok({"ok": True, "message": warning or "MCP 全局开关已保存", "mcp_config": cfg, "warning": warning})

            if path == "/api/mcp/servers/toggle":
                cfg = _read_mcp_config()
                servers = list(cfg.get("servers") or [])
                index = int(body.get("index", -1))
                if index < 0 or index >= len(servers):
                    return self._error(404, "MCP 服务不存在", detail={"index": index})
                servers[index] = dict(servers[index])
                servers[index]["enabled"] = bool(body.get("enabled", servers[index].get("enabled") is False))
                cfg["servers"] = servers
                cfg = _write_mcp_config(cfg)
                warning = _reload_mcp_tools_after_write()
                return self._ok({"ok": True, "message": warning or "MCP 服务开关已保存", "mcp_config": cfg, "warning": warning})

            if path == "/api/mcp/tools/refresh":
                cfg = body if body else _read_mcp_config()
                tools = _preview_mcp_tools(cfg)
                return self._ok({"ok": True, "tools": tools, "message": f"已获取 {len(tools)} 个 MCP 工具"})

            if path == "/api/plugins/toggle":
                entry = str(body.get("entry") or "").strip()
                if not entry:
                    return self._error(400, "缺少插件 entry")
                from core.plugins.plugin_host import set_plugin_manifest_enabled

                changed = set_plugin_manifest_enabled(entry, bool(body.get("enabled", True)))
                if not changed:
                    return self._error(404, "未找到插件清单条目", detail={"entry": entry})
                return self._ok({"ok": True, "message": "插件启用状态已保存，重启应用后完全生效", "plugins": _plugin_rows()})

            if path == "/api/plugins/catalog/install":
                try:
                    return self._ok(_install_catalog_plugin(body))
                except Exception as exc:
                    return self._error(500, str(exc))

            if path == "/api/plugins/open-settings":
                # 可选 fallback：Web 插件窗口优先读取插件包/配置文件；只有复杂 QWidget 设置页无法 Web 化时才打开原生窗口。
                helper = ROOT / "frontend_native_plugin_settings.py"
                target = helper if helper.is_file() else ROOT / "webui_qt.py"
                if not target.is_file():
                    return self._error(404, "未找到原生设置入口，无法打开插件设置")
                subprocess.Popen([sys.executable, str(target)], cwd=str(ROOT))
                return self._ok({"ok": True, "message": "已打开原生插件设置窗口（仅作为 Web 插件窗口无法覆盖时的 fallback）。"})

            if path == "/api/plugins/open-manifest":
                from core.plugins.plugin_host import read_plugin_manifest_items, write_plugin_manifest_items

                manifest = ROOT / "data" / "config" / "plugins.yaml"
                if not manifest.is_file():
                    write_plugin_manifest_items(read_plugin_manifest_items())
                _open_path(manifest)
                return self._ok({"ok": True, "message": f"已打开插件清单：{manifest}"})

            if path == "/api/mcp/open-config":
                from llm.tools.mcp_config_file import DEFAULT_MCP_CONFIG_PATH, default_mcp_config, write_mcp_config

                cfg_path = ROOT / DEFAULT_MCP_CONFIG_PATH
                if not cfg_path.is_file():
                    write_mcp_config(default_mcp_config(), DEFAULT_MCP_CONFIG_PATH)
                _open_path(cfg_path)
                return self._ok({"ok": True, "message": f"已打开 MCP 配置：{cfg_path}"})

            if path.startswith("/api/tools/"):
                tool = unquote(path.removeprefix("/api/tools/"))
                return self._ok({"ok": True, "tool": tool, "payload": body, "message": "工具 API 入口已连接；请在后端实现具体处理。"})

            return self._error(404, f"Unknown endpoint: {path}")
        except Exception as exc:
            traceback.print_exc()
            return self._error(500, str(exc))

    def do_DELETE(self) -> None:
        try:
            path = urlparse(self.path).path
            if path.startswith("/api/mcp/servers/"):
                index = int(unquote(path.removeprefix("/api/mcp/servers/")))
                return self._delete_mcp_server(index)

            if path.startswith("/api/plugins/manifest-row/"):
                entry = unquote(path.removeprefix("/api/plugins/manifest-row/"))
                from core.plugins.plugin_host import remove_plugin_manifest_entry

                if not entry.strip():
                    return self._error(400, "缺少插件 entry")
                changed = remove_plugin_manifest_entry(entry)
                if not changed:
                    return self._error(404, "未找到插件清单条目", detail={"entry": entry})
                return self._ok({"ok": True, "message": "插件清单条目已删除", "plugins": _plugin_rows()})

            if path.startswith("/api/characters/"):
                name = unquote(path.removeprefix("/api/characters/"))
                cm = _config_manager()
                before = len(cm.config.characters)
                cm.config.characters = [c for c in cm.config.characters if c.name.lower() != name.lower()]
                if len(cm.config.characters) == before:
                    return self._error(404, "未找到人物", detail={"name": name})
                cm.save_characters_config()
                return self._ok({"ok": True, "message": "人物已删除", "characters": cm.config.characters})

            if path.startswith("/api/backgrounds/"):
                name = unquote(path.removeprefix("/api/backgrounds/"))
                cm = _config_manager()
                before = len(cm.config.background_list)
                cm.config.background_list = [b for b in cm.config.background_list if b.name.lower() != name.lower()]
                if len(cm.config.background_list) == before:
                    return self._error(404, "未找到场景", detail={"name": name})
                cm.save_background_config()
                return self._ok({"ok": True, "message": "场景已删除", "backgrounds": cm.config.background_list})

            return self._error(404, f"Unknown endpoint: {path}")
        except Exception as exc:
            traceback.print_exc()
            return self._error(500, str(exc))

    def _list_templates(self) -> list[dict[str, Any]]:
        ctx = _ctx()
        root = _templates_dir(ctx)
        files = []
        for p in sorted(root.glob("*.txt"), key=lambda x: x.stat().st_mtime, reverse=True):
            files.append({
                "name": p.name,
                "path": str(p),
                "mtime": p.stat().st_mtime,
                "size": p.stat().st_size,
            })
        return files

    def _list_histories(self) -> list[dict[str, Any]]:
        root = ROOT / "data" / "chat_history"
        root.mkdir(parents=True, exist_ok=True)
        files = []
        for p in sorted(root.glob("*.json"), key=lambda x: x.stat().st_mtime, reverse=True):
            files.append({
                "name": p.name,
                "path": str(p),
                "mtime": p.stat().st_mtime,
                "size": p.stat().st_size,
            })
        return files

    def _load_template(self, name: str) -> None:
        ctx = _ctx()
        from ui.settings_ui.services.chat_template_handlers import load_template_from_file

        scenario, system, filename = load_template_from_file(ctx, name)
        return self._ok({
            "name": filename,
            "scenario": scenario,
            "system_template": system,
        })

    def _save_template(self, body: dict[str, Any]) -> None:
        ctx = _ctx()
        from ui.settings_ui.services.chat_template_handlers import save_template

        msg, files = save_template(
            ctx,
            str(body.get("scenario", "")),
            str(body.get("system_template", "")),
            str(body.get("filename") or body.get("session_name") or "template"),
        )
        return self._ok({"ok": True, "message": msg, "templates": files})

    def _generate_template(self, body: dict[str, Any]) -> None:
        ctx = _ctx()
        if getattr(ctx, "template_generator", None) is None:
            # 不阻塞前端：先返回用户情景，等后端完整 context 可用时自动走真实生成。
            return self._ok({
                "ok": True,
                "message": "模板生成器未初始化，已返回当前情景内容。",
                "scenario": body.get("scenario", ""),
                "system_template": "",
            })

        from ui.settings_ui.services.chat_template_handlers import generate_template

        system_template, output = generate_template(
            ctx,
            body.get("characters") or [],
            str(body.get("bg_name") or ""),
            str(body.get("use_effect") or "否"),
            str(body.get("use_translation") or "否"),
            str(body.get("use_cg") or "否"),
            str(body.get("use_cot") or "否"),
            str(body.get("use_choice") or "否"),
            str(body.get("use_narration") or "否"),
            int(body.get("max_speech_chars") or 120),
            int(body.get("max_dialog_items") or 20),
        )
        return self._ok({
            "ok": True,
            "message": output,
            "scenario": body.get("scenario", ""),
            "system_template": system_template,
        })

    def _save_system_config(self, body: dict[str, Any]) -> None:
        cm = _config_manager()
        data = cm.config.system_config.model_dump(mode="json", by_alias=True)
        for key, value in body.items():
            if key in data:
                data[key] = value
        from config.schema import SystemConfig

        cm.config.system_config = SystemConfig.model_validate(data)
        cm.save_system_config()
        return self._ok({"ok": True, "message": "系统配置已保存", "system_config": cm.config.system_config})

    def _save_adapter_extra(self, body: dict[str, Any]) -> None:
        cm = _config_manager()
        kind = str(body.get("kind") or "").strip().lower()
        provider = str(body.get("provider") or "").strip()
        data = body.get("data") if isinstance(body.get("data"), dict) else {}
        if kind not in {"llm", "tts", "asr", "t2i"}:
            return self._error(400, "无效适配器类型", detail={"kind": kind})
        if not provider:
            return self._error(400, "缺少 provider")
        cm.set_adapter_extra_config(kind, provider, data)
        cm.save_api_config()
        return self._ok({"ok": True, "message": f"{kind}:{provider} 扩展配置已保存", "api_config": cm.config.api_config})

    def _save_mcp_server(self, index: int, body: dict[str, Any]) -> None:
        cfg = _read_mcp_config()
        servers = list(cfg.get("servers") or [])
        if index < 0 or index >= len(servers):
            return self._error(404, "MCP 服务不存在", detail={"index": index})
        merged = dict(servers[index])
        merged.update(body)
        servers[index] = merged
        cfg["servers"] = servers
        cfg = _write_mcp_config(cfg)
        warning = _reload_mcp_tools_after_write()
        return self._ok({"ok": True, "message": warning or "MCP 服务已保存", "mcp_config": cfg, "warning": warning})

    def _add_mcp_server(self, body: dict[str, Any]) -> None:
        cfg = _read_mcp_config()
        servers = list(cfg.get("servers") or [])
        transport = str(body.get("transport") or "sse").strip().lower()
        row = {
            "enabled": bool(body.get("enabled", True)),
            "name_prefix": str(body.get("name_prefix") or ""),
            "transport": "stdio" if transport == "stdio" else "sse",
        }
        if row["transport"] == "stdio":
            row["command"] = str(body.get("command") or "")
            row["args"] = body.get("args") if isinstance(body.get("args"), list) else []
        else:
            row["url"] = str(body.get("url") or "")
            row["headers"] = body.get("headers") if isinstance(body.get("headers"), dict) else {}
        if body.get("call_timeout") not in (None, ""):
            row["call_timeout"] = float(body.get("call_timeout"))
        servers.append(row)
        cfg["servers"] = servers
        cfg = _write_mcp_config(cfg)
        warning = _reload_mcp_tools_after_write()
        return self._ok({"ok": True, "message": warning or "MCP 服务已添加", "mcp_config": cfg, "warning": warning})

    def _delete_mcp_server(self, index: int) -> None:
        cfg = _read_mcp_config()
        servers = list(cfg.get("servers") or [])
        if index < 0 or index >= len(servers):
            return self._error(404, "MCP 服务不存在", detail={"index": index})
        del servers[index]
        cfg["servers"] = servers
        cfg = _write_mcp_config(cfg)
        warning = _reload_mcp_tools_after_write()
        return self._ok({"ok": True, "message": warning or "MCP 服务已删除", "mcp_config": cfg, "warning": warning})

    def _save_plugin_manifest_row(self, body: dict[str, Any]) -> None:
        from core.plugins.plugin_host import read_plugin_manifest_items, write_plugin_manifest_items

        entry = str(body.get("entry") or "").strip()
        if not entry:
            return self._error(400, "缺少插件 entry")
        row = {k: v for k, v in body.items() if k not in {
            "display_name", "plugin_id", "plugin_version", "loaded", "package_dir", "package_exists",
            "settings_contributions", "tools_contributions", "has_settings", "has_tools",
        }}
        row["entry"] = entry
        items = read_plugin_manifest_items()
        replaced = False
        for i, item in enumerate(items):
            if str(item.get("entry") or "").strip() == entry:
                items[i] = row
                replaced = True
                break
        if not replaced:
            items.append(row)
        write_plugin_manifest_items(items)
        return self._ok({"ok": True, "message": "插件清单条目已保存，重启应用后完全生效", "plugins": _plugin_rows()})

    def _open_project_path(self, body: dict[str, Any]) -> None:
        raw = str(body.get("path") or "").strip()
        if not raw:
            return self._error(400, "缺少 path")
        p = Path(raw)
        if not p.is_absolute():
            p = ROOT / p
        _open_path(p)
        return self._ok({"ok": True, "message": f"已打开：{p}"})


    def _launch_status(self) -> dict[str, Any]:
        cm = _config_manager()
        api = cm.config.api_config
        syscfg = cm.config.system_config
        issues: list[str] = []
        checks: dict[str, Any] = {}

        provider = _normalize_llm_provider_name(getattr(api, "llm_provider", ""))
        model = ""
        key = ""
        try:
            model = _provider_map_value(api.llm_model, provider) or ""
            key = _provider_map_value(api.llm_api_key, provider) or ""
        except Exception:
            pass
        base_url = str(getattr(api, "llm_base_url", "") or "")
        llm_ok = bool(provider and model and (key or base_url))
        checks["llm"] = {"ok": llm_ok, "label": provider or "未配置", "model": model, "base_url": base_url}
        if not llm_ok:
            issues.append("LLM 未完整配置：需要供应商、模型 ID，并至少填入 API Key 或 Base URL。")

        characters = list(cm.config.characters or [])
        checks["characters"] = {"ok": bool(characters), "count": len(characters)}
        if not characters:
            issues.append("没有可用角色：请先导入或新建角色。")

        backgrounds = list(cm.config.background_list or [])
        bg_name = str(getattr(syscfg, "background_path", "") or "")
        checks["background"] = {"ok": bool(backgrounds), "count": len(backgrounds), "label": bg_name or (backgrounds[0].name if backgrounds else "TRANSPARENT")}
        if not backgrounds:
            issues.append("没有可用场景：可继续用透明背景，但演出预览不会有背景图。")

        templates = self._list_templates()
        temp = next((x for x in templates if x.get("name") == "_temp.txt" and int(x.get("size") or 0) > 0), None)
        latest = templates[0] if templates else None
        checks["template"] = {"ok": bool(temp or latest), "name": (temp or latest or {}).get("name", "")}
        if not (temp or latest):
            issues.append("没有可用聊天模板：请在会话构建里生成或保存模板。")

        histories = self._list_histories()
        checks["history"] = {"ok": bool(histories), "name": histories[0].get("name", "") if histories else "auto"}

        tts_provider = str(getattr(api, "tts_provider", "none") or "none")
        tts_on = tts_provider.lower() not in {"", "none", "off", "disabled", "disable"}
        tts_ready = (not tts_on) or bool(getattr(api, "gpt_sovits_url", "") or getattr(api, "gpt_sovits_api_path", ""))
        checks["tts"] = {"ok": tts_ready, "enabled": tts_on, "label": tts_provider if tts_on else "none"}
        if tts_on and not tts_ready:
            issues.append("TTS 已开启但服务地址/路径为空；可以关闭 TTS 或补全服务配置。")

        t2i_provider = str(getattr(api, "t2i_provider", "") or "")
        workflow = str(getattr(api, "t2i_default_workflow_path", "") or "")
        workflow_path = (ROOT / workflow).resolve() if workflow and not Path(workflow).is_absolute() else Path(workflow) if workflow else None
        t2i_configured = bool(t2i_provider and getattr(api, "t2i_api_url", ""))
        workflow_ok = bool(workflow_path and workflow_path.is_file())
        checks["t2i"] = {"ok": (not t2i_configured) or workflow_ok, "enabled": t2i_configured, "label": t2i_provider if t2i_configured else "none", "workflow": workflow}
        if t2i_configured and not workflow_ok:
            issues.append("T2I/ComfyUI 已配置但 workflow 文件不可用；启动时如开启 CG 可能失败。")

        try:
            import ui.settings_ui.services.chat_template_handlers as handlers
            proc = getattr(handlers, "_main_chat_process", None)
        except Exception:
            proc = None
        process = {"running": False, "pid": None, "exit_code": None}
        if proc is not None:
            process["pid"] = getattr(proc, "pid", None)
            code = proc.poll()
            process["running"] = code is None
            process["exit_code"] = code
        return {
            "ok": True,
            "can_launch": bool(llm_ok and characters and (temp or latest)),
            "issues": issues,
            "checks": checks,
            "process": process,
            "running": bool(process.get("running")),
            "project_root": str(ROOT),
        }

    def _launch(self, body: dict[str, Any]) -> None:
        ctx = _ctx()
        import ui.settings_ui.services.chat_template_handlers as handlers
        from ui.settings_ui.services.chat_template_handlers import launch_chat
        from llm.template_generator import TRANSPARENT_BG

        scenario = str(body.get("user_scenario") or body.get("scenario") or "")
        system_template = str(body.get("system_template") or "")

        # 兜底：前端未先点击「生成模板」时，直接按当前角色/场景生成一次系统模板。
        if not system_template.strip() and (body.get("characters") or body.get("bg_name")):
            try:
                if getattr(ctx, "template_generator", None) is not None:
                    from ui.settings_ui.services.chat_template_handlers import generate_template

                    system_template, _ = generate_template(
                        ctx,
                        body.get("characters") or [],
                        str(body.get("bg_name") or body.get("selected_bg") or ""),
                        str(body.get("use_effect") or "否"),
                        str(body.get("use_translation") or "否"),
                        str(body.get("use_cg") or "否"),
                        str(body.get("use_cot") or "否"),
                        str(body.get("use_choice") or "否"),
                        str(body.get("use_narration") or "否"),
                        int(body.get("max_speech_chars") or 120),
                        int(body.get("max_dialog_items") or 20),
                    )
            except Exception:
                traceback.print_exc()

        _repair_legacy_llm_provider_config()

        msg = launch_chat(
            ctx,
            scenario,
            system_template,
            str(body.get("init_sprite_path") or ""),
            str(body.get("history_file") or ""),
            str(body.get("selected_bg") or body.get("bg_name") or TRANSPARENT_BG),
            str(body.get("use_cg") or "否"),
            str(body.get("room_id") or ""),
        )

        proc = getattr(handlers, "_main_chat_process", None)
        pid = getattr(proc, "pid", None)
        # 很多“提示 PID 但没窗口”的情况是 main.py 立即退出；稍等一下再确认。
        if proc is not None:
            time.sleep(0.8)
            code = proc.poll()
            if code is not None:
                return self._error(500, "聊天进程启动后立即退出", detail={
                    "pid": pid,
                    "exit_code": code,
                    "message": msg,
                    "hint": "请看启动 frontend_desktop.py 的终端输出；常见原因是依赖缺失、配置文件读错目录、main.py 启动时报错。",
                    "project_root": str(ROOT),
                })

        return self._ok({"ok": True, "message": msg, "pid": pid, "project_root": str(ROOT)})

    def _resume_launch(self) -> None:
        ctx = _ctx()
        from ui.settings_ui.services.chat_template_handlers import launch_chat_resume_last

        ok, msg = launch_chat_resume_last(ctx)
        return self._ok({"ok": bool(ok), "message": msg})

    def _save_api_config(self, body: dict[str, Any]) -> None:
        cm = _config_manager()
        api = cm.config.api_config.model_copy(deep=True)

        requested_llm_provider = str(body.get("llm_provider") or api.llm_provider)
        llm_provider = _normalize_llm_provider_name(requested_llm_provider)
        supported = _supported_llm_provider_ids()
        if llm_provider not in supported:
            return self._error(400, "不支持的 LLM 供应商", detail={"provider": requested_llm_provider, "normalized": llm_provider, "supported": sorted(supported)})
        llm_model = str(body.get("llm_model") or _provider_map_value(api.llm_model, requested_llm_provider) or _provider_map_value(api.llm_model, llm_provider) or "")
        api_key = str(body.get("api_key") or _provider_map_value(api.llm_api_key, requested_llm_provider) or _provider_map_value(api.llm_api_key, llm_provider) or "")
        base_url = str(body.get("base_url") or body.get("llm_base_url") or api.llm_base_url)
        is_streaming = str(body.get("is_streaming") or ("是" if api.is_streaming else "否"))

        llm_extra_configs = body.get("llm_extra_configs")
        if isinstance(llm_extra_configs, dict):
            for provider_key, extra in llm_extra_configs.items():
                provider_norm = _normalize_llm_provider_name(provider_key)
                if provider_norm in supported and isinstance(extra, dict):
                    cm.set_adapter_extra_config(
                        "llm",
                        provider_norm,
                        _normalize_extra_config_value(extra),
                    )

        tts_provider = str(body.get("tts_provider") or api.tts_provider)
        sovits_url = str(body.get("sovits_url") or body.get("gpt_sovits_url") or api.gpt_sovits_url)
        gpt_sovits_api_path = str(body.get("gpt_sovits_api_path") or api.gpt_sovits_api_path)

        t2i_provider = str(body.get("t2i_provider") or api.t2i_provider)
        t2i_url = str(body.get("t2i_url") or body.get("t2i_api_url") or api.t2i_api_url)
        t2i_work_path = str(body.get("t2i_work_path") or api.t2i_work_path)
        workflow = str(body.get("t2i_default_workflow_path") or api.t2i_default_workflow_path)
        prompt_node_id = str(body.get("prompt_node_id") or body.get("t2i_prompt_node_id") or api.t2i_prompt_node_id)
        output_node_id = str(body.get("output_node_id") or body.get("t2i_output_node_id") or api.t2i_output_node_id)

        msg = cm.save_api_config_new(
            llm_provider,
            llm_model,
            api_key,
            base_url,
            is_streaming,
            tts_provider,
            sovits_url,
            gpt_sovits_api_path,
            t2i_provider,
            t2i_url,
            t2i_work_path,
            workflow,
            prompt_node_id,
            output_node_id,
            float(body.get("temperature", api.temperature)),
            float(body.get("repetition_penalty", api.repetition_penalty)),
            float(body.get("presence_penalty", api.presence_penalty)),
            float(body.get("frequency_penalty", api.frequency_penalty)),
            int(body.get("max_context_tokens", api.max_context_tokens)),
        )

        sc = cm.config.system_config.model_copy(deep=True)
        if body.get("asr_provider"):
            sc.asr_provider = str(body.get("asr_provider")).strip().lower().replace("-", "_")
        if "asr_language" in body:
            lang = str(body.get("asr_language") or "")
            lang_map = {
                "跟随界面语言": "",
                "中文": "zh",
                "English": "en",
                "日本語": "ja",
                "粵語": "yue",
            }
            sc.asr_language = lang_map.get(lang, lang)
        if body.get("asr_whisper_model_size"):
            sc.asr_whisper_model_size = str(body.get("asr_whisper_model_size"))
        if body.get("asr_whisper_device"):
            sc.asr_whisper_device = str(body.get("asr_whisper_device")).lower()
        cm.config.system_config = sc
        cm.save_system_config()

        return self._ok({"ok": True, "message": msg, "api_config": cm.config.api_config, "system_config": cm.config.system_config})


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", default=8765, type=int)
    args = parser.parse_args()

    server = ThreadingHTTPServer((args.host, args.port), ShinsekaiApiHandler)
    print(f"Shinsekai frontend listening on http://{args.host}:{args.port}")
    server.serve_forever()


if __name__ == "__main__":
    main()
