import { ShinsekaiAPI, getApiBase } from "./api.js";

/**
 * 只接 API，不改 UI：
 * - 保留 index.html 内所有结构、CSS 变量、颜色、布局和文案。
 * - 本文件只做导航、弹窗、数据灌入和后端 API 事件绑定。
 */

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));

let backendState = null;
let pluginCatalogState = { catalog: [], error: "", loaded: false, loading: false };
let currentSystemTemplate = "";
let currentTemplateName = "";
let currentSystemTemplateKey = "";
let selectedSessionCharacters = [];
let selectedBackgroundName = "";
let selectedBackgroundSpritePath = "";
let templateAutoGenerateTimer = null;
let sessionCastTouched = false;

const SESSION_RULES = [
  {
    key: "use_effect",
    label: "特效",
    display: "特效标记",
    on: "允许模板要求模型输出音效、画面变化、动作提示等演出标记；只有模板或插件支持时才会真的执行。",
    off: "不要求模型生成特效标记，输出更接近普通聊天。"
  },
  {
    key: "use_translation",
    label: "LLM翻译",
    display: "LLM 翻译",
    on: "把目标语言写进系统模板，让模型尽量按目标语言输出或处理翻译。适合角色设定和会话语言不一致时使用。",
    off: "不额外加入翻译约束，模型按角色设定、用户输入和默认语言自然回复。"
  },
  {
    key: "use_cg",
    label: "CG",
    display: "CG / 生图",
    on: "启动时启用 T2I/ComfyUI 管线，允许会话触发 CG 或生图。需要 ComfyUI 地址和 workflow 文件真实可用，否则可能启动失败或报错。",
    off: "不启动生图管线，只使用已有背景和角色立绘；如果暂时没配 ComfyUI，建议关闭。"
  },
  {
    key: "use_cot",
    label: "CoT推理",
    display: "剧情规划",
    on: "在模板里加入更强的剧情状态分析/步骤规划约束，让模型更会维持线索和因果；部分模型可能把分析文字也说出来。",
    off: "不加入额外推理结构，回复更干净、更像即时对话。"
  },
  {
    key: "use_choice",
    label: "选项规则",
    display: "玩家选项",
    on: "要求模型在合适时给出可选择的分支/行动选项，适合 Galgame 或剧情 RPG 式推进。",
    off: "不强制生成选项，用户可以自由输入，不被选项结构限制。"
  },
  {
    key: "use_narration",
    label: "旁白规则",
    display: "旁白描写",
    on: "允许模型输出环境、动作、心理和镜头感旁白，让演出更像剧情文本。",
    off: "尽量减少旁白，回复更偏角色对白和直接互动。"
  }
];

function ruleByKey(key) {
  return SESSION_RULES.find((rule) => rule.key === key) || null;
}

function ruleByLabel(label) {
  const clean = String(label || "").replace(/\s+/g, "").trim();
  return SESSION_RULES.find((rule) => rule.label.replace(/\s+/g, "") === clean || rule.display.replace(/\s+/g, "") === clean) || null;
}

function ruleCurrentHint(rule, enabled) {
  if (!rule) return "";
  return `当前：${enabled ? "已开启" : "已关闭"}。开启：${rule.on} 关闭：${rule.off}`;
}

function textOf(node) {
  return (node?.textContent || "").replace(/\s+/g, " ").trim();
}

function templateDisplayName(name) {
  return String(name || "")
    .replace(/\.txt$/i, "")
    .replace(/^_temp$/i, "上次临时会话")
    .trim();
}

const TEMPLATE_SCENARIO_MARK = "<<<EASYAI_USER_SCENARIO>>>";
const TEMPLATE_SYSTEM_MARK = "<<<EASYAI_SYSTEM_TEMPLATE>>>";

async function loadRawTemplateText(name) {
  try {
    const path = `data/character_templates/${String(name || "").replace(/^\/+/, "")}`;
    const response = await fetch(`${getApiBase()}/api/assets?path=${encodeURIComponent(path)}`);
    if (!response.ok) return "";
    return await response.text();
  } catch {
    return "";
  }
}

function hasStoredTemplateMarks(raw) {
  return String(raw || "").includes(TEMPLATE_SCENARIO_MARK)
    && String(raw || "").includes(TEMPLATE_SYSTEM_MARK);
}

function normalizeLoadedTemplate(res, raw = "") {
  const scenario = String(res?.scenario || "").trim();
  const system = String(res?.system_template || "").trim();
  if (system || !scenario || scenario.startsWith("加载失败") || hasStoredTemplateMarks(raw)) {
    return { scenario, system, legacyCombined: false };
  }
  return { scenario: "", system: scenario, legacyCombined: true };
}

function isBlankSessionName(value) {
  const v = String(value || "").trim();
  return !v;
}

function isBlankScenario(value) {
  const v = String(value || "").trim();
  return !v;
}


function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function projectAssetUrl(path) {
  const p = String(path || "").trim();
  if (!p) return "";
  if (/^(https?:|data:|blob:|file:)/i.test(p)) return p;
  return `${getApiBase()}/api/assets?path=${encodeURIComponent(p)}`;
}

function resourcePath(item) {
  if (!item) return "";
  if (typeof item === "string") return item;
  return item.path || item.file || item.url || item.src || item.image || item.image_path || "";
}

function firstResourcePath(list) {
  if (!Array.isArray(list)) return "";
  for (const item of list) {
    const path = resourcePath(item);
    if (path) return path;
  }
  return "";
}

function applyImageToBox(box, path, mode = "cover", position = "center") {
  if (!box) return;
  const url = projectAssetUrl(path);
  if (!url) {
    box.style.backgroundImage = "";
    return;
  }
  box.style.backgroundImage = `url("${url}")`;
  box.style.backgroundSize = mode;
  box.style.backgroundRepeat = "no-repeat";
  box.style.backgroundPosition = position;
}

function summarizeMultiline(value, max = 180) {
  const text = String(value || "").replace(/\r\n/g, "\n").trim();
  if (!text) return "尚未填写介绍。";
  if (text.length <= max) return text;
  const cut = text.slice(0, max).replace(/[，。；、,.!?！？：:\s]+$/g, "");
  return `${cut}…`;
}

function characterIntroText(character) {
  // 卡片只显示角色设定摘要，不显示 prompt_text / 参考音频文本等完整提示词。
  return summarizeMultiline(character?.character_setting || character?.description || character?.summary || "", 180);
}

function bgmTagLines(bg) {
  const raw = String(bg?.bgm_tags || "").replace(/\r\n/g, "\n").trim();
  return raw ? raw.split(/\n+/).map((x) => x.trim()).filter(Boolean) : [];
}

function bgmMoodForIndex(bg, index) {
  const lines = bgmTagLines(bg);
  return lines[index] || lines.find((line) => line.includes(String(index + 1))) || String(bg?.bgm_tags || "").trim() || "暂无音乐氛围标注。";
}

function realCharacterNameSet() {
  return new Set(normalizeCharacters(backendState).map((c) => c.name).filter(Boolean));
}

function toNameList(names) {
  if (Array.isArray(names)) return names;
  if (typeof names === "string") return names.split(/[,，、\n]/);
  return [];
}

function sanitizeSessionCharacterNames(names, { allowUnknown = false } = {}) {
  const realNames = realCharacterNameSet();
  return Array.from(new Set(toNameList(names)
    .map((x) => String(x || "").trim())
    .filter(Boolean)
    .filter((name) => allowUnknown || !realNames.size || realNames.has(name))));
}

function selectedCharactersFromInput() {
  const raw = getField("出场角色", $("#screen-sessions"));
  return sanitizeSessionCharacterNames(raw);
}

function syncSelectedCharactersInput() {
  const root = $("#screen-sessions");
  const input = findFieldControl("出场角色", root);
  if (input) input.value = selectedSessionCharacters.join(", ");
}

function setSelectedSessionCharacters(names, { mirrorInput = false } = {}) {
  sessionCastTouched = true;
  selectedSessionCharacters = sanitizeSessionCharacterNames(names);
  if (mirrorInput) syncSelectedCharactersInput();
  return selectedSessionCharacters;
}

function currentBackground() {
  const name = selectedBackgroundName || getField("场景背景", $("#screen-sessions"));
  return normalizeBackgrounds(backendState).find((bg) => bg.name === name) || firstBackground() || null;
}

function currentBackgroundSpritePath() {
  const bg = currentBackground();
  if (selectedBackgroundSpritePath) return selectedBackgroundSpritePath;
  return firstResourcePath(bg?.sprites);
}

function currentLeadCharacter() {
  const name = currentCastNames()[0];
  return normalizeCharacters(backendState).find((c) => c.name === name) || null;
}

function setToggleState(toggle, on) {
  if (!toggle) return;
  const value = !!on;
  toggle.dataset.on = value ? "true" : "false";
  toggle.classList.toggle("is-on", value);
  toggle.setAttribute("role", "switch");
  toggle.setAttribute("tabindex", "0");
  toggle.setAttribute("aria-checked", value ? "true" : "false");
  toggle.title = value ? "已启用，点击关闭" : "已关闭，点击启用";
}

function ensureToggleInteractionStyle() {
  if (document.getElementById("shinsekai-toggle-state-style")) return;
  const style = document.createElement("style");
  style.id = "shinsekai-toggle-state-style";
  style.textContent = `
    .toggle[data-on="true"]::after { left: 18px; }
    .toggle[data-on="false"]::after { left: 2px; }
    .check-row[data-rule-key] { cursor: pointer; }
    .rule-help-line { margin: -4px 0 10px 0; padding: 0 0 10px 0; border-bottom: 1px solid var(--divider-subtle); }
    .char-intro-text { white-space: pre-line; overflow: hidden; display: -webkit-box; -webkit-line-clamp: 4; -webkit-box-orient: vertical; }
    .template-preview-block { white-space: pre-wrap; max-height: 180px; overflow: auto; border-top: 1px solid var(--divider-subtle); margin-top: 10px; padding-top: 10px; }
    .launch-monitor-line { white-space: pre-line; }
    .about-card { display: grid; gap: 16px; padding: 4px 0; }
    .about-hero { border: var(--border-thin); background: var(--accent-blue); padding: 22px; }
    .about-kicker { font-size: 10px; text-transform: uppercase; letter-spacing: 0; margin-bottom: 8px; color: var(--ink-muted); }
    .about-title { font-family: var(--font-serif); font-size: 28px; line-height: 1.05; margin: 0 0 8px; }
    .about-copy { color: var(--ink-muted); font-size: 13px; line-height: 1.7; }
    .about-credits { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
    .about-credit { border: var(--border-thin); background: var(--surface); padding: 16px; }
    .about-credit h3 { font-size: 13px; margin: 0 0 8px; }
    .about-credit a { color: inherit; text-decoration: underline; text-underline-offset: 3px; }
    @media (max-width: 720px) { .about-credits { grid-template-columns: 1fr; } }
    .stage-figure.has-image { background-color: transparent !important; border: none !important; border-radius: 0 !important; box-shadow: none !important; width: min(34vw, 360px); height: min(68%, 560px); bottom: 116px; z-index: 1; }
    .stage-preview .dialogue-box { position: relative; z-index: 3; }
    [data-llm-thinking-row] { cursor: pointer; }
    [data-llm-thinking-row].is-disabled { opacity: 0.45; cursor: not-allowed; }
    [data-llm-thinking-row].is-disabled .toggle { pointer-events: none; }
    [data-llm-thinking-help] { margin-top: -6px; }
  `;
  document.head.appendChild(style);
}

function getToggleState(toggle) {
  return toggle?.dataset.on !== "false";
}

function isTruthyValue(value) {
  if (typeof value === "boolean") return value;
  if (value === null || value === undefined) return false;
  return ["1", "true", "yes", "on", "是", "启用", "enabled"].includes(String(value).trim().toLowerCase());
}

function findApiToggle(name, root = $("#screen-services")) {
  return root?.querySelector(`[data-api-toggle="${CSS.escape(name)}"]`) || null;
}

function getApiToggleState(name, fallback = false) {
  const toggle = findApiToggle(name);
  return toggle ? getToggleState(toggle) : fallback;
}

function setApiToggleState(name, on) {
  setToggleState(findApiToggle(name), on);
}

function mapValueForProvider(map, provider, fallback = undefined) {
  if (!map || typeof map !== "object") return fallback;
  const canonical = normalizeLlmProviderValue(provider);
  const keys = [provider, canonical];
  const direct = keys.find((key) => key && map[key] !== undefined && map[key] !== null);
  if (direct) return map[direct];
  const lowered = Object.fromEntries(Object.entries(map).map(([k, v]) => [String(k).toLowerCase(), v]));
  const loweredKey = keys.map((key) => String(key || "").toLowerCase()).find((key) => lowered[key] !== undefined && lowered[key] !== null);
  return loweredKey ? lowered[loweredKey] : fallback;
}

function findButton(label, root = document) {
  return $$("button, .btn-action, .nav-item, .tool-icon", root)
    .find((el) => textOf(el) === label || textOf(el).includes(label));
}

function findFieldControl(labelText, root = document, index = 0) {
  const labels = $$("label", root).filter((label) => textOf(label) === labelText);
  const label = labels[index];
  if (!label) return null;
  return label.closest(".field")?.querySelector("input, select, textarea") || null;
}

function ensureSelectValue(select, value) {
  if (!select || select.tagName !== "SELECT" || value === undefined || value === null) return;
  const s = String(value);
  const exists = Array.from(select.options).some((opt) => opt.value === s || opt.textContent === s);
  if (!exists && s) {
    const option = document.createElement("option");
    option.value = s;
    option.textContent = s;
    select.appendChild(option);
  }
}

function setSelectOptions(select, values) {
  if (!select || select.tagName !== "SELECT") return;
  select.innerHTML = "";
  values.forEach((item) => {
    const option = document.createElement("option");
    if (typeof item === "string") {
      option.value = item;
      option.textContent = item;
    } else {
      option.value = item.value;
      option.textContent = item.label;
    }
    select.appendChild(option);
  });
}

function setField(labelText, value, root = document, index = 0) {
  const input = findFieldControl(labelText, root, index);
  if (!input || value === undefined || value === null) return;
  ensureSelectValue(input, value);
  input.value = String(value);
}

function getField(labelText, root = document, index = 0) {
  const input = findFieldControl(labelText, root, index);
  return input ? input.value : "";
}

function notify(message) {
  window.alert(message);
}

function yesNoFromToggle(toggle) {
  return getToggleState(toggle) ? "是" : "否";
}

function llmProviderSupportsThinking(provider) {
  return normalizeLlmProviderValue(provider).toLowerCase() === "deepseek";
}

function currentLlmExtraConfig(provider) {
  const extras = backendState?.api_config?.llm_extra_configs || {};
  return mapValueForProvider(extras, provider, {}) || {};
}

function syncLlmThinkingUi(provider = getField("供应商", $("#screen-services")), { preserveToggleState = false } = {}) {
  const services = $("#screen-services");
  const toggle = findApiToggle("thinking", services);
  if (!toggle) return;
  const canonical = normalizeLlmProviderValue(provider);
  const supported = llmProviderSupportsThinking(canonical);
  const extra = currentLlmExtraConfig(canonical);
  const enabled = supported && (preserveToggleState ? getToggleState(toggle) : isTruthyValue(extra.thinking_enabled));
  setToggleState(toggle, enabled);
  toggle.dataset.locked = supported ? "false" : "true";
  toggle.setAttribute("aria-disabled", supported ? "false" : "true");
  const row = services?.querySelector("[data-llm-thinking-row]");
  row?.classList.toggle("is-disabled", !supported);
  const label = row?.querySelector("span");
  if (label) label.textContent = `模型思考模式${enabled ? "：已开启" : "：已关闭"}`;
  const help = services?.querySelector("[data-llm-thinking-help]");
  if (help) {
    help.textContent = supported
      ? "DeepSeek 支持 thinking_enabled；开启后会禁用不兼容的采样参数，并保留 reasoning_effort。"
      : "当前供应商没有声明思考模式扩展参数；切换到 Deepseek 后可使用。";
  }
}

function collectLlmExtraConfigs(provider) {
  const api = backendState?.api_config || {};
  const existing = api.llm_extra_configs && typeof api.llm_extra_configs === "object"
    ? JSON.parse(JSON.stringify(api.llm_extra_configs))
    : {};
  const canonical = normalizeLlmProviderValue(provider);
  if (!llmProviderSupportsThinking(canonical)) return existing;
  const current = currentLlmExtraConfig(canonical);
  existing[canonical] = {
    ...current,
    thinking_enabled: getApiToggleState("thinking", false),
    reasoning_effort: current.reasoning_effort || "high"
  };
  return existing;
}

function formatCount(label, count) {
  return `${label}：${Number(count || 0)}`;
}

function formatMtime(ts) {
  if (!ts) return "未知时间";
  try {
    return new Date(ts * 1000).toLocaleString();
  } catch {
    return "未知时间";
  }
}

function normalizeCharacters(state) {
  return Array.isArray(state?.characters) ? state.characters : [];
}

function normalizeBackgrounds(state) {
  return Array.isArray(state?.backgrounds) ? state.backgrounds : [];
}

function normalizeTemplates(state) {
  return Array.isArray(state?.templates) ? state.templates : [];
}

function normalizeHistories(state) {
  return Array.isArray(state?.histories) ? state.histories : [];
}

function normalizeLlmProviderValue(value) {
  const raw = String(value || "").trim();
  const lowered = raw.toLowerCase();
  const aliases = {
    "openai compatible": "ChatGPT",
    "openai-compatible": "ChatGPT",
    "openai_compatible": "ChatGPT",
    "openai compat": "ChatGPT",
    "openai": "ChatGPT",
    "openai 兼容": "ChatGPT",
    "openai兼容": "ChatGPT",
    "openai兼容端点": "ChatGPT",
    "chatgpt": "ChatGPT"
  };
  if (aliases[lowered]) return aliases[lowered];
  const rows = Array.isArray(backendState?.llm_providers) ? backendState.llm_providers : [];
  const direct = rows.find((row) => String(row.id).toLowerCase() === lowered || String(row.label).toLowerCase() === lowered);
  if (direct) return direct.id;
  const alias = rows.find((row) => Array.isArray(row.aliases) && row.aliases.some((a) => String(a).toLowerCase() === lowered));
  return alias?.id || raw;
}

function llmProviderRows(state = backendState) {
  const rows = Array.isArray(state?.llm_providers) ? state.llm_providers : [];
  if (rows.length) return rows;
  return [
    { id: "Deepseek", label: "Deepseek", aliases: [] },
    { id: "ChatGPT", label: "ChatGPT / OpenAI Compatible", aliases: ["OpenAI Compatible", "OpenAI", "OpenAI兼容"] },
    { id: "Gemini", label: "Gemini", aliases: [] },
    { id: "Claude", label: "Claude", aliases: [] },
    { id: "豆包", label: "豆包", aliases: [] },
    { id: "通义千问", label: "通义千问", aliases: [] }
  ];
}

function mapProviderValue(map, provider, fallback = "") {
  if (!map || typeof map !== "object") return fallback;
  const canonical = normalizeLlmProviderValue(provider);
  const keys = [provider, canonical];
  if (canonical === "ChatGPT") {
    keys.push("OpenAI Compatible", "openai compatible", "OpenAI", "openai", "OpenAI兼容");
  }
  for (const key of keys) {
    if (key && map[key] !== undefined && map[key] !== null && String(map[key]) !== "") return map[key];
  }
  const lowered = Object.fromEntries(Object.entries(map).map(([k, v]) => [String(k).toLowerCase(), v]));
  for (const key of keys) {
    const v = lowered[String(key || "").toLowerCase()];
    if (v !== undefined && v !== null && String(v) !== "") return v;
  }
  return fallback;
}

function applyLlmProviderFields(provider, { preserveCustomBase = false } = {}) {
  const services = $("#screen-services");
  const api = backendState?.api_config || {};
  const canonical = normalizeLlmProviderValue(provider);
  const row = llmProviderRows().find((item) => item.id === canonical);
  setField("供应商", canonical, services);
  setField("模型ID", mapProviderValue(api.llm_model, canonical, api.llm_model_current || ""), services);
  setField("API Key", mapProviderValue(api.llm_api_key, canonical, api.llm_api_key_current || ""), services);
  const currentBase = getField("Base URL", services);
  const savedBase = api.llm_base_url || api.base_url || "";
  const base = savedBase || row?.base_url || currentBase;
  if (!preserveCustomBase || !currentBase) setField("Base URL", base, services);
  syncLlmThinkingUi(canonical);
}

function setupLlmProviderSelect(state = backendState) {
  const services = $("#screen-services");
  const select = findFieldControl("供应商", services);
  if (!select) return;
  const rows = llmProviderRows(state);
  setSelectOptions(select, rows.map((row) => ({ value: row.id, label: row.label || row.id })));
  const api = state?.api_config || {};
  const effective = normalizeLlmProviderValue(api.llm_provider_effective || api.llm_provider || api.llm_provider_raw || select.value);
  ensureSelectValue(select, effective);
  select.value = effective;
  if (!select.dataset.shinsekaiProviderWired) {
    select.dataset.shinsekaiProviderWired = "true";
    select.addEventListener("change", () => {
      applyLlmProviderFields(select.value);
      refreshAllDerivedState();
    });
  }
}


function firstCharacter() {
  return normalizeCharacters(backendState)[0] || null;
}

function firstBackground() {
  return normalizeBackgrounds(backendState)[0] || null;
}

function currentCastNames() {
  if (!selectedSessionCharacters.length) {
    selectedSessionCharacters = selectedCharactersFromInput();
  } else {
    selectedSessionCharacters = sanitizeSessionCharacterNames(selectedSessionCharacters);
  }
  return selectedSessionCharacters.slice();
}

function clearHistoryBinding() {
  const roots = [$("#screen-sessions"), $("#screen-launch")].filter(Boolean);
  for (const root of roots) {
    ["历史文件", "历史文件路径", "历史记录", "历史路径", "会话历史"].forEach((label) => {
      const input = findFieldControl(label, root);
      if (input) input.value = "";
    });
  }
}

function clearSessionTemplateBinding() {
  currentTemplateName = "";
  currentSystemTemplate = "";
  currentSystemTemplateKey = "";
}

function markFreshSession(reason = "") {
  clearHistoryBinding();
  // 换角色/换场景后不再继续沿用 _temp 的旧角色、旧场景。
  if (reason === "character" || reason === "background") {
    clearSessionTemplateBinding();
  }
  refreshAllDerivedState?.();
}

function sessionTemplateKey(session) {
  const cast = Array.isArray(session?.characters) ? session.characters : currentCastNames();
  return JSON.stringify({
    characters: cast.map((x) => String(x || "").trim()).filter(Boolean),
    bg_name: String(session?.bg_name || selectedBackgroundName || getField("场景背景", $("#screen-sessions")) || ""),
    use_effect: String(session?.use_effect || ""),
    use_translation: String(session?.use_translation || ""),
    use_cg: String(session?.use_cg || ""),
    use_cot: String(session?.use_cot || ""),
    use_choice: String(session?.use_choice || ""),
    use_narration: String(session?.use_narration || ""),
    max_speech_chars: Number(session?.max_speech_chars || 0),
    max_dialog_items: Number(session?.max_dialog_items || 0)
  });
}

function setCurrentSystemTemplate(value, key = "") {
  currentSystemTemplate = String(value || "");
  currentSystemTemplateKey = currentSystemTemplate ? key : "";
}

function systemTemplateForLaunch(session) {
  if (currentSystemTemplateKey && currentSystemTemplateKey !== sessionTemplateKey(session)) return "";
  return currentSystemTemplate;
}

function scheduleTemplateAutoGenerate() {
  window.clearTimeout(templateAutoGenerateTimer);
  const cast = currentCastNames();
  if (!cast.length) return;
  templateAutoGenerateTimer = window.setTimeout(async () => {
    try {
      const payload = collectSessionBuilder();
      const res = await ShinsekaiAPI.generateTemplate(payload);
      if (!res?.system_template) return;
      setCurrentSystemTemplate(res.system_template, sessionTemplateKey(payload));
      renderTemplatePreview({ ...payload, system_template: currentSystemTemplate });
      refreshAllDerivedState();
    } catch (err) {
      console.warn("自动生成模板失败", err);
    }
  }, 350);
}

function collectUserPreferenceText() {
  const roots = [$("#screen-sessions"), $("#screen-launch"), $("#screen-services")].filter(Boolean);
  const labels = ["用户偏好", "用户喜好", "玩家偏好", "偏好", "User Preference", "User Preferences"];
  for (const root of roots) {
    for (const label of labels) {
      const value = getField(label, root);
      if (String(value || "").trim()) return String(value).trim();
    }
  }
  return "";
}

function installSessionStateGuards() {
  if (window.__shinsekaiSessionGuardsInstalled) return;
  window.__shinsekaiSessionGuardsInstalled = true;

  const originalLaunch = ShinsekaiAPI.launch;
  ShinsekaiAPI.launch = (payload = {}) => {
    const cast = currentCastNames();
    const bg = selectedBackgroundName || getField("场景背景", $("#screen-sessions")) || payload.selected_bg || "";
    return originalLaunch({
      ...payload,
      characters: cast,
      character_names: cast,
      selected_characters: cast,
      selected_bg: bg,
      bg_name: bg,
      user_preference: collectUserPreferenceText(),
      user_preferences: collectUserPreferenceText()
    });
  };

  const originalGenerateTemplate = ShinsekaiAPI.generateTemplate;
  ShinsekaiAPI.generateTemplate = (payload = {}) => {
    const cast = currentCastNames();
    const bg = selectedBackgroundName || getField("场景背景", $("#screen-sessions")) || payload.bg_name || "";
    return originalGenerateTemplate({
      ...payload,
      characters: cast,
      character_names: cast,
      selected_characters: cast,
      bg_name: bg,
      selected_bg: bg,
      user_preference: collectUserPreferenceText(),
      user_preferences: collectUserPreferenceText()
    });
  };

  document.addEventListener("click", (event) => {
    const btn = event.target.closest("button, .btn-action, .timeline-item, .char-card, .gallery-tile");
    if (!btn) return;
    const text = textOf(btn);

    if (/清除历史|清空历史|新会话|新建会话|重新开始/.test(text)) {
      setTimeout(() => markFreshSession("clear-history"), 0);
      return;
    }

    if (/继续上次|恢复历史|加载历史|载入历史|打开历史/.test(text)) {
      const path = btn.dataset?.historyFile || btn.dataset?.path || "";
      if (path) setField("历史文件路径", path, $("#screen-sessions"));
      return;
    }

    if (/加入会话|选择角色|设为出场|移除/.test(text) && btn.closest("#screen-characters, #screen-sessions")) {
      setTimeout(() => markFreshSession("character"), 0);
      setTimeout(scheduleTemplateAutoGenerate, 0);
      return;
    }

    if (/替换场景|加入会话|使用场景|选择场景/.test(text) && btn.closest("#screen-scenes, #screen-sessions")) {
      setTimeout(() => markFreshSession("background"), 0);
      setTimeout(scheduleTemplateAutoGenerate, 0);
    }
  }, true);

  document.addEventListener("change", (event) => {
    const el = event.target;
    if (!el || !el.closest) return;
    const field = el.closest(".field");
    const label = textOf($("label", field));
    if (/出场角色|场景背景|角色|背景/.test(label)) {
      if (/出场角色|角色/.test(label) && el.closest("#screen-sessions")) {
        setSelectedSessionCharacters(selectedCharactersFromInput());
      }
      markFreshSession(/场景|背景/.test(label) ? "background" : "character");
      scheduleTemplateAutoGenerate();
    }
  }, true);
}

function wireOriginalNavigation() {
  const navItems = $$(".nav-item");
  const screens = $$(".screen");
  navItems.forEach((item) => {
    item.addEventListener("click", () => {
      navItems.forEach((n) => n.classList.remove("active"));
      item.classList.add("active");
      const target = item.dataset.target;
      screens.forEach((s) => s.classList.toggle("active", s.id === `screen-${target}`));
    });
  });
}

function wireOriginalToolModal() {
  const modal = $("#tool-modal");
  const title = $("#modal-title");
  const subtitle = $("#modal-subtitle");
  const content = $("#modal-content");
  if (!modal || !title || !subtitle || !content) return;

  const data = {
    about: {
      title: "About",
      subtitle: "作者与致谢",
      html: `
        <div class="about-card">
          <section class="about-hero">
            <div class="about-kicker">Shinsekai Credits</div>
            <h2 class="about-title">新世界 WebUI</h2>
            <p class="about-copy">这是基于 Shinsekai 原项目延伸出的本地 WebView 前端。核心后端、角色演出链路与主要 Python 实现来自原作者；当前 WebUI、桌面接入和界面设计在此基础上继续优化。</p>
          </section>
          <section class="about-credits">
            <article class="about-credit">
              <h3>原项目 / 后端实现</h3>
              <p class="about-copy">Shinsekai 原项目、核心后端实现、本地配置与演出运行逻辑由 <a href="https://github.com/RachelForster" target="_blank" rel="noreferrer">不二咲爱笑 / RachelForster</a> 创作与维护。</p>
            </article>
            <article class="about-credit">
              <h3>WebUI / 设计优化</h3>
              <p class="about-copy"><a href="https://github.com/DasterProkio" target="_blank" rel="noreferrer">DasterProkio</a> 在原项目基础上优化 WebUI、桌面 WebView 接入、交互结构与视觉设计体验。</p>
            </article>
          </section>
          <section class="about-credit">
            <h3>开源致谢</h3>
            <p class="about-copy">感谢 PySide6 / Qt WebEngine、Vite，以及项目中使用到的各类开源依赖、插件作者与社区贡献者。</p>
          </section>
        </div>`
    },
    portrait: {
      title: "生成肖像",
      subtitle: "基于角色设定、参考图和提示词批量生成立绘",
      html: '<div class="field"><label>选择角色</label><select></select></div><div class="field"><label>生成数量</label><input type="number" value="4"></div><div class="field"><label>参考图</label><input placeholder="选择参考图路径"></div><div class="field"><label>提示词</label><textarea></textarea></div><div class="field"><label>输出目录</label><input placeholder="data/sprite/output"></div><div class="split-row"><button class="btn-action" data-tool-action="portrait-prompt">生成提示词</button><button class="btn-action" data-tool-action="portrait-generate">生成立绘</button></div>'
    },
    removebg: {
      title: "抠图",
      subtitle: "批量去除图片背景",
      html: '<div class="field"><label>输入目录</label><input placeholder="选择输入目录"></div><div class="field"><label>输出目录</label><input placeholder="选择输出目录"></div><button class="btn-action" data-tool-action="removebg">执行去背景</button><textarea readonly>等待执行结果...</textarea>'
    },
    crop: {
      title: "批量裁剪",
      subtitle: "批量裁剪角色立绘上半身或指定比例",
      html: '<div class="field"><label>输入目录</label><input placeholder="选择输入目录"></div><div class="field"><label>输出目录</label><input placeholder="选择输出目录"></div><div class="field"><label>裁剪比例</label><input type="number" step="0.05" value="1.0"></div><button class="btn-action" data-tool-action="crop">执行裁剪</button><textarea readonly>等待执行结果...</textarea>'
    }
  };

  $$(".tool-icon, .user-meta[data-modal]").forEach((icon) => {
    icon.addEventListener("click", () => {
      const item = data[icon.dataset.modal];
      if (!item) return;
      title.textContent = item.title;
      subtitle.textContent = item.subtitle;
      content.innerHTML = item.html;
      const roleSelect = findFieldControl("选择角色", modal);
      const names = normalizeCharacters(backendState).map((c) => c.name).filter(Boolean);
      if (roleSelect && names.length) setSelectOptions(roleSelect, names);
      modal.classList.add("active");
    });
  });

  $("#modal-close")?.addEventListener("click", () => modal.classList.remove("active"));
  modal.addEventListener("click", (e) => {
    if (e.target === modal) modal.classList.remove("active");
  });

  modal.addEventListener("click", async (event) => {
    const btn = event.target.closest("[data-tool-action]");
    if (!btn) return;

    const action = btn.dataset.toolAction;
    const payload = {};
    $$(".field", modal).forEach((field) => {
      const label = textOf($("label", field));
      const control = $("input, select, textarea", field);
      if (label && control) payload[label] = control.value;
    });

    try {
      const result = await ShinsekaiAPI.runTool(action, payload);
      const output = $("textarea[readonly]", modal);
      if (output) output.value = JSON.stringify(result, null, 2);
      else notify(result?.message || "执行完成");
    } catch (err) {
      notify(`工具执行失败：${err.message}`);
    }
  });
}

function wireTogglesAsStateOnly() {
  $$(".toggle").forEach((toggle) => {
    setToggleState(toggle, toggle.dataset.on !== "false");
    toggle.addEventListener("click", () => {
      if (toggle.dataset.locked === "true" || toggle.getAttribute("aria-disabled") === "true") return;
      if (toggle.dataset.mcpIndex !== undefined || toggle.dataset.mcpGlobal !== undefined) return;
      setToggleState(toggle, !getToggleState(toggle));
      if (toggle.dataset.apiToggle === "thinking") syncLlmThinkingUi(undefined, { preserveToggleState: true });
      if (toggle.closest("#screen-sessions")) {
        clearSessionTemplateBinding();
        scheduleTemplateAutoGenerate();
      }
      refreshAllDerivedState();
    });
    toggle.addEventListener("keydown", (event) => {
      if (event.key !== " " && event.key !== "Enter") return;
      event.preventDefault();
      toggle.click();
    });
  });

  const thinkingRow = $("#screen-services [data-llm-thinking-row]");
  thinkingRow?.addEventListener("click", (event) => {
    if (event.target.closest(".toggle") || thinkingRow.classList.contains("is-disabled")) return;
    findApiToggle("thinking")?.click();
  });
}

function wireSessionRuleRows() {
  $$("#screen-sessions .detail-card").forEach((card) => {
    if (!textOf($(".char-name", card)).includes("演出规则")) return;
    const rows = $$(".check-row", card);
    rows.forEach((row, index) => {
      const toggle = $(".toggle", row);
      if (!toggle) return;
      const rule = SESSION_RULES[index] || ruleByLabel(textOf($$("span", row)[0])) || { key: `rule_${index}`, label: textOf($$("span", row)[0]), display: textOf($$("span", row)[0]) };
      row.dataset.ruleKey = rule.key;
      const labelSpan = $$("span", row)[0];
      if (labelSpan && rule.display) labelSpan.textContent = rule.display;
      row.title = "点击切换此演出规则";
      const help = document.createElement("p");
      help.className = "muted-line rule-help-line";
      help.dataset.ruleHelpFor = rule.key;
      row.insertAdjacentElement("afterend", help);
      row.addEventListener("click", (event) => {
        if (event.target.closest(".toggle")) return;
        toggle.click();
      });
      updateRuleHelpLine(rule.key);
    });
  });
}

function updateRuleHelpLine(key) {
  const rule = ruleByKey(key);
  const row = $(`#screen-sessions .check-row[data-rule-key="${CSS.escape(key)}"]`);
  const help = $(`#screen-sessions [data-rule-help-for="${CSS.escape(key)}"]`);
  if (!rule || !row || !help) return;
  const enabled = getToggleState($(".toggle", row));
  help.textContent = ruleCurrentHint(rule, enabled);
}

function updateAllRuleHelpLines() {
  SESSION_RULES.forEach((rule) => updateRuleHelpLine(rule.key));
}

function collectApiConfig() {
  const services = $("#screen-services");
  const llmProvider = normalizeLlmProviderValue(getField("供应商", services) || "ChatGPT");

  return {
    llm_provider: llmProvider,
    llm_model: getField("模型ID", services),
    api_key: getField("API Key", services),
    base_url: getField("Base URL", services),
    is_streaming: getApiToggleState("streaming", true) ? "是" : "否",
    llm_extra_configs: collectLlmExtraConfigs(llmProvider),

    temperature: Number(getField("温度", services) || 0.7),
    presence_penalty: Number(getField("presence_penalty", services) || 0),
    frequency_penalty: Number(getField("frequency_penalty", services) || 0),
    repetition_penalty: Number(getField("repetition_penalty", services) || 1),
    max_context_tokens: Number(getField("最大上下文token", services) || 0),

    tts_provider: getField("TTS 引擎", services),
    sovits_url: getField("服务地址", services),
    gpt_sovits_api_path: getField("服务/整合包路径", services),

    asr_provider: getField("识别引擎", services),
    asr_language: getField("识别语言", services),
    asr_whisper_model_size: getField("模型", services),
    asr_whisper_device: getField("设备", services),

    t2i_provider: getField("生图引擎", services),
    t2i_url: getField("API 地址", services),
    t2i_work_path: "",
    t2i_default_workflow_path: getField("默认工作流文件", services),
    prompt_node_id: getField("提示词节点ID", services),
    output_node_id: getField("输出节点ID", services)
  };
}

function hydrateApiConfig(api) {
  const services = $("#screen-services");
  if (!services || !api) return;

  setupLlmProviderSelect(backendState || { api_config: api });
  const provider = normalizeLlmProviderValue(api.llm_provider_effective || api.llm_provider || api.llm_provider_raw || "ChatGPT");
  setField("供应商", provider, services);
  setField("模型ID", mapProviderValue(api.llm_model, provider, api.llm_model_current || api.llm_model || ""), services);
  setField("Base URL", api.llm_base_url || api.base_url || "", services);
  setField("API Key", mapProviderValue(api.llm_api_key, provider, api.llm_api_key_current || api.api_key || ""), services);
  setApiToggleState("streaming", api.is_streaming !== false);
  syncLlmThinkingUi(provider);

  setField("温度", api.temperature, services);
  setField("presence_penalty", api.presence_penalty, services);
  setField("frequency_penalty", api.frequency_penalty, services);
  setField("repetition_penalty", api.repetition_penalty, services);
  setField("最大上下文token", api.max_context_tokens, services);

  setField("TTS 引擎", api.tts_provider, services);
  setField("服务地址", api.gpt_sovits_url || api.sovits_url, services);
  setField("服务/整合包路径", api.gpt_sovits_api_path, services);

  setField("生图引擎", api.t2i_provider, services);
  setField("API 地址", api.t2i_api_url || api.t2i_url, services);
  setField("默认工作流文件", api.t2i_default_workflow_path, services);
  setField("提示词节点ID", api.t2i_prompt_node_id || api.prompt_node_id, services);
  setField("输出节点ID", api.t2i_output_node_id || api.output_node_id, services);
}

function collectCharacterEditor() {
  const root = $("#screen-characters");
  const boundName = root?.dataset.currentCharacterName || "";
  const current = normalizeCharacters(backendState).find((c) => c.name === boundName) || {};
  const name = getField("人物名称", root) || current.name || "";
  const color = getField("名称显示颜色", root) || current.color || "";
  const spritePrefix = getField("上传数据目录名", root) || getField("资源目录名", root) || current.sprite_prefix || "";
  return {
    ...current,
    name,
    color,
    sprite_prefix: spritePrefix,
    character_setting: getField("角色设定", root),
    sprites: Array.isArray(current.sprites) ? current.sprites : [],
    emotion_tags: current.emotion_tags || ""
  };
}

function collectBackgroundEditor() {
  const root = $("#screen-scenes");
  const boundName = root?.dataset.currentBackgroundName || "";
  const current = normalizeBackgrounds(backendState).find((b) => b.name === boundName) || {};
  const name = getField("场景名称", root) || current.name || "";
  const spritePrefix = getField("资源目录名", root) || current.sprite_prefix || "";
  return {
    ...current,
    name,
    sprite_prefix: spritePrefix,
    bg_tags: getField("图片说明 / 标签", root),
    sprites: Array.isArray(current.sprites) ? current.sprites : [],
    bgm_list: Array.isArray(current.bgm_list) ? current.bgm_list : [],
    bgm_tags: current.bgm_tags || ""
  };
}

function collectSessionBuilder() {
  const root = $("#screen-sessions");
  const toggles = $$(".toggle", root);
  return {
    session_name: getField("会话名称", root) || getField("会话昵称", root),
    language: getField("目标语言", root),
    characters: currentCastNames(),
    bg_name: selectedBackgroundName || getField("场景背景", root),
    scenario: getField("用户情景", root),
    system_template: currentSystemTemplate,
    use_effect: yesNoFromToggle(toggles[0]),
    use_translation: yesNoFromToggle(toggles[1]),
    use_cg: yesNoFromToggle(toggles[2]),
    use_cot: yesNoFromToggle(toggles[3]),
    use_choice: yesNoFromToggle(toggles[4]),
    use_narration: yesNoFromToggle(toggles[5]),
    max_speech_chars: Number(getField("单句最大字数", root) || 120),
    max_dialog_items: Number(getField("最大对话条数", root) || 20),
    init_sprite_path: getField("初始立绘路径", root),
    history_file: getField("历史文件路径", root)
  };
}

function characterMeta(character) {
  const sprites = Array.isArray(character.sprites) ? character.sprites.length : 0;
  const voice = character.gpt_model_path || character.sovits_model_path || character.refer_audio_path ? "已配置" : "未配置";
  return `${formatCount("立绘", sprites)} // 声音：${voice}`;
}

function fillCharacterCard(card, character, index) {
  card.removeAttribute("data-template-card");
  const badge = $(".floating-badge", card);
  const name = $(".char-name", card);
  const meta = $(".char-meta", card);
  const image = $(".char-image", card);
  const info = $(".char-info", card);
  let quote = $(".char-info p:not(.char-meta)", card);
  if (!quote && info) {
    quote = document.createElement("p");
    quote.style.fontSize = "12px";
    quote.style.fontStyle = "italic";
    const actions = Array.from(info.children).find((el) => el.tagName === "DIV" && el.querySelector("button"));
    info.insertBefore(quote, actions || null);
  }
  const spritePath = firstResourcePath(character.sprites);
  applyImageToBox(image, spritePath, "contain", "center top");
  if (badge) badge.textContent = character.character_setting ? "就绪" : "缺设定";
  if (name) name.textContent = character.name || `角色 ${index + 1}`;
  if (meta) meta.textContent = characterMeta(character);
  if (quote) { quote.textContent = characterIntroText(character); quote.classList.add("char-intro-text"); }
  $$('button', card).forEach((btn) => {
    if (textOf(btn).includes("编辑")) {
      btn.onclick = () => hydrateCharacterEditor(character);
    }
    if (textOf(btn).includes("记忆")) {
      btn.onclick = () => openCharacterFullEditor(character);
    }
    if (textOf(btn).includes("加入")) {
      btn.onclick = () => addCharacterToSession(character.name);
    }
  });
}

function hydrateCharacterEditor(character) {
  const root = $("#screen-characters");
  if (root) root.dataset.currentCharacterName = character?.name || "";
  setField("人物名称", character.name || "", root);
  setField("名称显示颜色", character.color || "", root);
  setField("角色设定", character.character_setting || "", root);
  renderCharacterGallery(character);
}

function renderCharacterGallery(character) {
  const root = $("#screen-characters");
  const strip = $(".detail-card.drawer .gallery-strip", root);
  if (!strip) return;
  const sprites = Array.isArray(character.sprites) ? character.sprites : [];
  if (!sprites.length) {
    strip.innerHTML = '<div class="gallery-tile"><span class="floating-badge">无立绘</span></div>';
    return;
  }
  strip.innerHTML = sprites.map((sprite, index) => {
    const label = escapeHtml(characterSpriteLabel(character, sprite, index));
    const path = escapeHtml(resourcePath(sprite));
    return `<div class="gallery-tile" data-character-sprite-index="${index}" data-character-sprite-path="${path}" title="${label} | ${path}"><span class="floating-badge">${label}</span></div>`;
  }).join("");
  $$("[data-character-sprite-path]", strip).forEach((tile, index) => {
    const path = tile.dataset.characterSpritePath || resourcePath(sprites[index]);
    applyImageToBox(tile, path, "contain", "center top");
  });
}

function addCharacterToSession(name) {
  if (!name) return;
  clearSessionTemplateBinding();
  clearHistoryBinding();
  selectedSessionCharacters = currentCastNames();
  if (!selectedSessionCharacters.includes(name)) selectedSessionCharacters.push(name);
  selectedSessionCharacters = sanitizeSessionCharacterNames(selectedSessionCharacters);
  syncSelectedCharactersInput();
  renderCurrentCastList();
  refreshAllDerivedState();
}

function removeCharacterFromSession(name) {
  clearSessionTemplateBinding();
  clearHistoryBinding();
  selectedSessionCharacters = currentCastNames().filter((x) => x !== name);
  syncSelectedCharactersInput();
  renderCurrentCastList();
  refreshAllDerivedState();
}

function renderCurrentCastList() {
  const characters = normalizeCharacters(backendState);
  const selected = currentCastNames()
    .map((name) => characters.find((c) => c.name === name) || { name })
    .filter((c) => c.name);
  const castList = $("#screen-characters aside:last-child .ext-list");
  if (castList) {
    castList.innerHTML = selected.length
      ? selected.map((c) => `<li class="ext-item" style="padding:10px 0;" data-cast-name="${escapeHtml(c.name)}"><div class="ext-info"><h4>${escapeHtml(c.name || "未命名角色")}</h4><p>${formatCount("sprites", Array.isArray(c.sprites) ? c.sprites.length : 0)}</p></div><button class="btn-action" data-remove-cast="${escapeHtml(c.name)}">移除</button></li>`).join("")
      : '<li class="ext-item" style="padding:10px 0;"><div class="ext-info"><h4>暂无出场角色</h4><p>点击角色卡片「加入会话」</p></div></li>';
    castList.onclick = (event) => {
      const btn = event.target.closest("[data-remove-cast]");
      if (!btn) return;
      removeCharacterFromSession(btn.dataset.removeCast || "");
    };
  }
}

function hydrateCharacters(state) {
  const characters = normalizeCharacters(state);
  const grid = $("#screen-characters .card-grid");
  if (!grid || !characters.length) return;
  const drawer = $("#screen-characters .detail-card.drawer");
  const templates = $$("#screen-characters .char-card").map((x) => x.cloneNode(true));
  $$("#screen-characters .char-card").forEach((x) => x.remove());
  characters.forEach((character, index) => {
    const card = (templates[index % templates.length] || templates[0]).cloneNode(true);
    fillCharacterCard(card, character, index);
    grid.insertBefore(card, drawer || null);
  });
  hydrateCharacterEditor(characters[0]);

  currentCastNames();
  syncSelectedCharactersInput();
  renderCurrentCastList();
}

function backgroundMeta(bg) {
  const sprites = Array.isArray(bg.sprites) ? bg.sprites.length : 0;
  const bgm = Array.isArray(bg.bgm_list) ? bg.bgm_list.length : 0;
  return `背景：${sprites} // BGM：${bgm}`;
}

function fillBackgroundCard(card, bg, index) {
  card.removeAttribute("data-template-card");
  const badge = $(".floating-badge", card);
  const name = $(".char-name", card);
  const meta = $(".char-meta", card);
  const image = $(".char-image", card);
  const desc = $(".char-info p:not(.char-meta)", card);
  applyImageToBox(image, firstResourcePath(bg.sprites), "cover");
  if (badge) badge.textContent = Array.isArray(bg.bgm_list) && bg.bgm_list.length ? "就绪" : "缺BGM";
  if (name) name.textContent = bg.name || `场景 ${index + 1}`;
  if (meta) meta.textContent = backgroundMeta(bg);
  if (desc) desc.textContent = bg.bg_tags || "尚未填写场景说明。";
  $$("button", card).forEach((btn) => {
    if (textOf(btn).includes("编辑")) {
      btn.onclick = () => hydrateBackgroundEditor(bg);
    }
    if (textOf(btn).includes("加入")) {
      btn.onclick = () => setSessionBackground(bg.name);
    }
  });
}

function previewLabelForResource(item, index) {
  const path = resourcePath(item);
  if (item && typeof item === "object") {
    return item.voice_text || item.label || item.name || item.emotion || item.tag || path.split(/[\\/]/).pop() || `图 ${index + 1}`;
  }
  return path.split(/[\\/]/).pop() || `图 ${index + 1}`;
}

function indexedTagLabel(text, index, prefix = "") {
  const wanted = index + 1;
  const padded = String(wanted).padStart(2, "0");
  const lines = String(text || "").replace(/\r\n/g, "\n").split("\n").map((line) => line.trim()).filter(Boolean);
  for (const line of lines) {
    const match = line.match(/^(?:立绘|场景|sprite)\s*0?(\d+)\s*[：:]\s*(.*)$/i)
      || line.match(/^0?(\d+)\s*[：:]\s*(.*)$/);
    if (!match || Number(match[1]) !== wanted) continue;
    const body = String(match[2] || "").trim();
    return body ? `${padded} · ${body}` : `${prefix || "图"} ${padded}`;
  }
  return "";
}

function characterSpriteLabel(character, sprite, index) {
  return indexedTagLabel(character?.emotion_tags, index, "立绘")
    || previewLabelForResource(sprite, index);
}

function backgroundSpriteLabel(bg, sprite, index) {
  return indexedTagLabel(bg?.bg_tags, index, "场景")
    || previewLabelForResource(sprite, index);
}

function renderBackgroundGallery(bg) {
  const root = $("#screen-scenes");
  const strip = $(".detail-card.drawer .gallery-strip", root);
  if (!strip) return;
  const sprites = Array.isArray(bg?.sprites) ? bg.sprites : [];
  if (!sprites.length) {
    strip.innerHTML = '<div class="gallery-tile"><span class="floating-badge">无图片</span></div>';
    return;
  }
  strip.innerHTML = sprites.map((sprite, index) => {
    const label = escapeHtml(backgroundSpriteLabel(bg, sprite, index));
    const path = escapeHtml(resourcePath(sprite));
    return `<div class="gallery-tile" data-bg-sprite-index="${index}" data-bg-sprite-path="${path}" title="${label} | ${path}"><span class="floating-badge">${label}</span></div>`;
  }).join("");
  $$('[data-bg-sprite-path]', strip).forEach((tile, index) => {
    const path = tile.dataset.bgSpritePath || resourcePath(sprites[index]);
    applyImageToBox(tile, path, "cover");
    tile.addEventListener("click", () => {
      selectedBackgroundName = bg?.name || selectedBackgroundName;
      selectedBackgroundSpritePath = path;
      setField("场景背景", selectedBackgroundName, $("#screen-sessions"));
      updateSelectedBackgroundPanel(bg);
      refreshAllDerivedState();
    });
  });
}

function renderBackgroundBgmList(bg) {
  const root = $("#screen-scenes");
  const drawer = $(".detail-card.drawer", root);
  if (!drawer) return;
  const lists = $$(".ext-list", drawer);
  const bgmList = lists[lists.length - 1];
  if (!bgmList) return;
  const bgms = Array.isArray(bg?.bgm_list) ? bg.bgm_list : [];
  bgmList.innerHTML = bgms.length
    ? bgms.map((item, index) => {
        const name = String(item).split(/[\\/]/).pop() || `BGM ${index + 1}`;
        const mood = bgmMoodForIndex(bg, index);
        return `<li class="ext-item" style="padding:10px 0;" data-bgm-index="${index}"><div class="ext-info"><h4>${escapeHtml(name)}</h4><p>${escapeHtml(mood)}</p><p class="muted-line">${escapeHtml(String(item))}</p></div><button class="btn-action" data-bgm-index="${index}">查看标注</button></li>`;
      }).join("")
    : '<li class="ext-item" style="padding:10px 0;"><div class="ext-info"><h4>暂无 BGM</h4><p>在场景详细设置里填写 bgm_list 与 bgm_tags</p></div></li>';
  bgmList.onclick = (event) => {
    const row = event.target.closest("[data-bgm-index]");
    if (!row) return;
    openBgmMoodViewer(bg, Number(row.dataset.bgmIndex || 0));
  };
}

function openBgmMoodViewer(bg = currentBackground(), index = 0) {
  const list = Array.isArray(bg?.bgm_list) ? bg.bgm_list : [];
  const path = list[index] || "";
  openEditorModal({
    title: "音乐氛围标注",
    subtitle: `${bg?.name || "当前场景"} · ${String(path).split(/[\\/]/).pop() || `BGM ${index + 1}`}`,
    fields: [
      { key: "bgm_path", label: "BGM 文件", value: path },
      { key: "mood", label: "本条氛围", value: bgmMoodForIndex(bg, index), type: "textarea" },
      { key: "bgm_tags", label: "全部 bgm_tags", value: bg?.bgm_tags || "", type: "textarea" }
    ],
    onSave: async (payload) => {
      const updated = { ...(bg || {}) };
      const lines = bgmTagLines(updated);
      while (lines.length <= index) lines.push("");
      lines[index] = payload.mood || "";
      updated.bgm_tags = payload.bgm_tags || lines.join("\n");
      const res = await ShinsekaiAPI.saveBackground(updated.name, updated);
      backendState = await ShinsekaiAPI.appState();
      hydrateBackgroundEditor(normalizeBackgrounds(backendState).find((x) => x.name === updated.name) || updated);
      return res;
    }
  });
}

function updateSelectedBackgroundPanel(bg = currentBackground()) {
  const selected = $("#screen-scenes aside:last-child .section-group .char-name");
  const selectedLine = $("#screen-scenes aside:last-child .section-group .muted-line");
  if (selected) selected.textContent = bg?.name || "当前场景";
  if (selectedLine) selectedLine.textContent = bg ? backgroundMeta(bg) : "未选择场景";
}

function hydrateBackgroundEditor(bg) {
  const root = $("#screen-scenes");
  if (root) root.dataset.currentBackgroundName = bg?.name || "";
  setField("场景名称", bg.name || "", root);
  setField("资源目录名", bg.sprite_prefix || "", root);
  setField("图片说明 / 标签", bg.bg_tags || "", root);
  if (bg?.name) {
    selectedBackgroundName = bg.name;
    selectedBackgroundSpritePath = firstResourcePath(bg.sprites);
    setField("场景背景", selectedBackgroundName, $("#screen-sessions"));
  }
  renderBackgroundGallery(bg);
  renderBackgroundBgmList(bg);
  updateSelectedBackgroundPanel(bg);
  refreshAllDerivedState();
}

function setSessionBackground(name) {
  clearSessionTemplateBinding();
  clearHistoryBinding();
  selectedBackgroundName = name || "";
  const bg = normalizeBackgrounds(backendState).find((item) => item.name === selectedBackgroundName) || null;
  selectedBackgroundSpritePath = firstResourcePath(bg?.sprites);
  const root = $("#screen-sessions");
  setField("场景背景", selectedBackgroundName, root);
  if (bg) hydrateBackgroundEditor(bg);
  else refreshAllDerivedState();
}

function hydrateBackgrounds(state) {
  const backgrounds = normalizeBackgrounds(state);
  const grid = $("#screen-scenes .center-grid");
  if (!grid || !backgrounds.length) return;
  const drawer = $("#screen-scenes .detail-card.drawer");
  const templates = $$("#screen-scenes .char-card").map((x) => x.cloneNode(true));
  $$("#screen-scenes .char-card").forEach((x) => x.remove());
  backgrounds.forEach((bg, index) => {
    const card = (templates[index % templates.length] || templates[0]).cloneNode(true);
    fillBackgroundCard(card, bg, index);
    grid.insertBefore(card, drawer || null);
  });
  if (!selectedBackgroundName) {
    selectedBackgroundName = getField("场景背景", $("#screen-sessions")) || backgrounds[0].name || "";
    setField("场景背景", selectedBackgroundName, $("#screen-sessions"));
  }
  const active = backgrounds.find((bg) => bg.name === selectedBackgroundName) || backgrounds[0];
  hydrateBackgroundEditor(active);
}

function hydrateTemplatesAndHistories(state) {
  const root = $("#screen-sessions");
  const templates = normalizeTemplates(state);
  const histories = normalizeHistories(state);
  const templateSelect = $("aside .section-group select", root);
  if (templateSelect && templates.length) {
    setSelectOptions(templateSelect, templates.map((t) => t.name));
    const preferred = templates.find((t) => t.name === currentTemplateName) || templates[0];
    templateSelect.value = preferred.name;
    const sessionNameInput = findFieldControl("会话名称", root) || findFieldControl("会话昵称", root);
    if (sessionNameInput && isBlankSessionName(sessionNameInput.value)) {
      sessionNameInput.value = "未命名会话";
    }
  } else {
    const sessionNameInput = findFieldControl("会话名称", root) || findFieldControl("会话昵称", root);
    const scenarioInput = findFieldControl("用户情景", root);
    if (sessionNameInput && isBlankSessionName(sessionNameInput.value)) sessionNameInput.value = "未命名会话";
    if (scenarioInput && isBlankScenario(scenarioInput.value)) scenarioInput.value = "";
  }

  const historyGroup = $$("#screen-sessions aside .section-group").find((g) => textOf($(".section-label", g)) === "最近历史");
  if (historyGroup && histories.length) {
    const label = $(".section-label", historyGroup)?.outerHTML || '<span class="section-label">最近历史</span>';
    historyGroup.innerHTML = label + histories.slice(0, 5).map((h) => `<div class="timeline-item"><h4>${h.name}</h4><p class="muted-line">最后修改：${formatMtime(h.mtime)}</p></div>`).join("");
  }

  const bg = firstBackground();
  currentCastNames();
  syncSelectedCharactersInput();
  if (!selectedBackgroundName && bg) {
    selectedBackgroundName = bg.name || "";
    setField("场景背景", selectedBackgroundName, root);
  }
}

function hydrateLaunchSummary(state) {
  const bg = currentBackground() || firstBackground();
  const launch = $("#screen-launch");
  if (bg) {
    const bgRows = $$(".check-row", launch).filter((r) => textOf($("span:first-child", r)) === "bg" || textOf($("span:first-child", r)) === "背景");
    bgRows.forEach((row) => {
      const spans = $$("span", row);
      if (spans[1]) spans[1].textContent = bg.name;
    });
  }
  const cast = currentCastNames();
  const roleLabel = cast.length ? cast.join("、") : "未选择";
  const roleRows = $$(".check-row", launch).filter((r) => textOf($("span:first-child", r)) === "角色");
  roleRows.forEach((row) => {
    const spans = $$("span", row);
    if (spans[1]) spans[1].textContent = roleLabel;
  });
  const speaker = $("#screen-launch .speaker-name");
  const lead = currentLeadCharacter();
  if (speaker) speaker.textContent = lead?.name || "未选择角色";
}


function hydrateLaunchPreview(state) {
  const bg = currentBackground();
  const char = currentLeadCharacter();
  const stage = $("#screen-launch .stage-preview");
  const figure = $("#screen-launch .stage-figure");
  const dialogueStage = $("#screen-services .chat-stage");
  const dialogueSpeaker = $("#screen-services .speaker-name");
  const dialogueText = $("#screen-services .typewriter-text");
  const bgPath = currentBackgroundSpritePath();
  applyImageToBox(stage, bgPath, "cover");
  applyImageToBox(dialogueStage, bgPath, "cover");
  const spritePath = firstResourcePath(char?.sprites);
  applyImageToBox(figure, spritePath, "contain", "center bottom");
  if (figure) {
    figure.classList.toggle("has-image", !!spritePath);
    figure.style.display = spritePath ? "block" : "none";
  }
  const speaker = $("#screen-launch .speaker-name");
  const text = $("#screen-launch .typewriter-text");
  if (speaker) speaker.textContent = char?.name || "未选择角色";
  if (text) text.textContent = char ? (characterIntroText(char) || "演出预览会显示当前角色与场景。") : "请先在角色库中点击「加入会话」，再启动演出。";
  if (dialogueSpeaker) dialogueSpeaker.textContent = char?.name || "未选择角色";
  if (dialogueText) dialogueText.textContent = char ? (characterIntroText(char) || "服务预览已绑定当前角色。") : "尚未选择出场角色。";
}

function setStatusPill(pill, text, available = true) {
  if (!pill) return;
  pill.textContent = text;
  pill.classList.toggle("status-available", available);
  pill.classList.toggle("status-unconfigured", !available);
}

function hydrateStatusPanels(state) {
  const api = state?.api_config || {};
  const sys = state?.system_config || {};
  const chars = normalizeCharacters(state);
  const bgs = normalizeBackgrounds(state);
  const hasLlm = !!(api.llm_provider && (api.llm_base_url || api.base_url) && (api.llm_model?.[api.llm_provider] || api.llm_model));
  const hasTts = !!(api.tts_provider && String(api.tts_provider).toLowerCase() !== "none" && (api.gpt_sovits_url || api.gpt_sovits_api_path));
  const hasAsr = !!(sys.asr_provider || api.asr_provider);
  const hasT2i = !!(api.t2i_provider && api.t2i_api_url);

  $$("#screen-services .check-row").forEach((row) => {
    const label = textOf($$("span", row)[0]);
    const pill = $(".status-pill", row);
    if (label === "LLM") setStatusPill(pill, hasLlm ? "READY" : "MISSING", hasLlm);
    if (label === "TTS") setStatusPill(pill, hasTts ? "READY" : "OPTIONAL", hasTts);
    if (label === "ASR") setStatusPill(pill, hasAsr ? "READY" : "OFF", hasAsr);
    if (label === "ComfyUI") setStatusPill(pill, hasT2i ? "READY" : "OFF", hasT2i);
  });

  $$("#screen-sessions .check-row").forEach((row) => {
    const label = textOf($$("span", row)[0]);
    const pill = $(".status-pill", row);
    if (label === "LLM") setStatusPill(pill, hasLlm ? "OK" : "MISS", hasLlm);
    if (label === "角色") {
      const cast = currentCastNames();
      setStatusPill(pill, String(cast.length || 0), cast.length > 0);
    }
    if (label === "背景") setStatusPill(pill, bgs.length ? "OK" : "MISS", bgs.length > 0);
    if (label === "模板") setStatusPill(pill, currentSystemTemplate || getField("用户情景", $("#screen-sessions")) ? "READY" : "EMPTY", !!(currentSystemTemplate || getField("用户情景", $("#screen-sessions"))));
  });
}

function hydrateSessionPlugins(state) {
  const plugins = (state?.plugins || []).filter((p) => p.enabled !== false);
  const list = $("#screen-sessions aside:last-child .ext-list");
  if (!list) return;
  list.innerHTML = plugins.length
    ? plugins.slice(0, 5).map((p) => {
      const panelLink = pluginHasPanel(p)
        ? `<span style="font-size: 10px; text-decoration: underline;" data-plugin-session-settings="${escapeHtml(p.entry || "")}">设置</span>`
        : "";
      return `<li class="ext-item" style="padding:10px 0;" data-session-plugin="${escapeHtml(p.entry || "")}"><div class="ext-info"><h4>${escapeHtml(pluginDisplayName(p, 0))}</h4><p>${escapeHtml(pluginSubtitle(p))}</p></div>${panelLink}</li>`;
    }).join("")
    : '<li class="ext-item" style="padding:10px 0;"><div class="ext-info"><h4>暂无活跃插件</h4><p>到服务页启用插件</p></div></li>';
  list.onclick = async (event) => {
    const el = event.target.closest("[data-plugin-session-settings]");
    if (!el) return;
    const entry = el.dataset.pluginSessionSettings || "";
    const plugin = (backendState?.plugins || []).find((p) => String(p.entry || "") === entry) || { entry };
    openPluginDetailEditor(plugin);
  };
}

function enabledRuleLabels() {
  const session = $("#screen-sessions");
  const ruleCard = $$(".detail-card", session).find((card) => textOf($(".char-name", card)).includes("演出规则"));
  if (!ruleCard) return [];
  return $$(".check-row", ruleCard)
    .filter((row) => getToggleState($(".toggle", row)))
    .map((row) => ruleByKey(row.dataset.ruleKey)?.display || textOf($$("span", row)[0]))
    .filter(Boolean);
}

function renderTemplatePreview(session = collectSessionBuilder()) {
  const body = $("#screen-sessions .detail-card.wide-card:last-child .detail-body");
  if (!body) return;
  let preview = $("[data-template-preview-block]", body);
  if (!preview) {
    const original = $(".muted-line", body);
    if (original) original.dataset.templatePreviewSummary = "true";
    preview = document.createElement("div");
    preview.className = "muted-line template-preview-block";
    preview.dataset.templatePreviewBlock = "true";
    body.appendChild(preview);
    preview.addEventListener("click", openSystemTemplateEditor);
  }
  const name = currentTemplateName || session.session_name || "未命名模板";
  const scenario = String(session.scenario || "").trim();
  const system = String(currentSystemTemplate || session.system_template || "").trim();
  const summary = $(`[data-template-preview-summary]`, body);
  if (summary) summary.textContent = system
    ? `当前模板：${templateDisplayName(name)}。点击「展开编辑」或下方预览可完整编辑。`
    : (scenario ? `当前会话已填写用户情景；点击「生成模板」生成系统模板，或点击下方直接编辑。` : "请填写用户情景，或从左侧加载真实模板。");
  preview.textContent = system
    ? system
    : (scenario ? `【用户情景】\n${scenario}` : "暂无系统模板内容。点击这里打开完整编辑器。");
}

function syncRuleAndBasicInfoPanels() {
  const session = collectSessionBuilder();
  const rules = enabledRuleLabels();

  renderTemplatePreview(session);

  const launch = $("#screen-launch");
  $$(".check-row", launch).forEach((row) => {
    const spans = $$("span", row);
    const label = textOf(spans[0]);
    if (label === "规则" && spans[1]) spans[1].textContent = rules.length ? rules.join("/") : "未启用";
    if (label === "template" && spans[1]) spans[1].textContent = currentTemplateName ? templateDisplayName(currentTemplateName) : (session.session_name || "_temp");
    if (label === "history" && spans[1]) spans[1].textContent = session.history_file ? "指定" : "自动";
    if (label === "t2i" && spans[1]) spans[1].textContent = session.use_cg === "是" ? "ComfyUI" : "none";
  });
}

async function hydrateLaunchMonitor() {
  try {
    const status = await ShinsekaiAPI.launchStatus();
    renderLaunchMonitor(status || {});
  } catch (err) {
    renderLaunchMonitor({ ok: false, error: err.message });
  }
}

function renderLaunchMonitor(status) {
  const launch = $("#screen-launch");
  if (!launch) return;
  const stateCard = $$(".section-group", launch).find((group) => textOf($(".section-label", group)).includes("状态"));
  if (stateCard) {
    const title = $(".char-name", stateCard);
    const line = $(".muted-line", stateCard);
    const running = !!status.running;
    const exited = status.process?.exit_code !== undefined && status.process?.exit_code !== null;
    if (title) title.textContent = running ? "演出进程运行中" : (exited ? "演出进程已退出" : (status.can_launch ? "可以启动" : "需要补全配置"));
    if (line) {
      line.classList.add("launch-monitor-line");
      const issues = Array.isArray(status.issues) ? status.issues : [];
      const pid = status.process?.pid ? `PID：${status.process.pid}` : "暂无运行进程";
      line.textContent = issues.length ? `${pid}\n${issues.join("\n")}` : `${pid}\n必要条件已满足。TTS / ASR / ComfyUI 按当前配置检测。`;
    }
  }

  const checks = status.checks || {};
  $$(".check-row", launch).forEach((row) => {
    const spans = $$("span", row);
    const label = textOf(spans[0]);
    if (!spans[1]) return;
    if (label === "template") spans[1].textContent = checks.template?.ok ? "READY" : "EMPTY";
    if (label === "history") spans[1].textContent = checks.history?.ok ? "json" : "auto";
    if (label === "bg") spans[1].textContent = checks.background?.label || (selectedBackgroundName || "TRANSPARENT");
    if (label === "tts") spans[1].textContent = checks.tts?.label || "none";
    if (label === "t2i") spans[1].textContent = checks.t2i?.label || "none";
  });
}

function refreshAllDerivedState() {
  hydrateLaunchSummary(backendState || {});
  hydrateLaunchPreview(backendState || {});
  hydrateStatusPanels(backendState || {});
  syncRuleAndBasicInfoPanels();
  updateAllRuleHelpLines();
  hydrateLaunchMonitor();
}


function mcpServerTitle(server, index) {
  const prefix = String(server?.name_prefix || "").trim();
  if (prefix) return prefix;
  if (String(server?.transport || "").toLowerCase() === "stdio") {
    return String(server?.command || `MCP 服务 ${index + 1}`);
  }
  return String(server?.url || `MCP 服务 ${index + 1}`);
}

function mcpServerSubtitle(server) {
  const transport = String(server?.transport || "sse").toLowerCase();
  const enabled = server?.enabled === false ? "已停用" : "已启用";
  if (transport === "stdio") {
    const args = Array.isArray(server?.args) ? server.args.join(" ") : "";
    return `${transport} // ${enabled}${args ? ` // ${args}` : ""}`;
  }
  return `${transport.toUpperCase()} // ${enabled}`;
}

function hydrateMcpServices(state) {
  const cfg = state?.mcp_config || { enabled: true, servers: [] };
  const services = $("#screen-services");
  if (!services) return;

  const mcpGroup = $$(".section-group", services)
    .find((group) => textOf($(".section-label", group)).includes("MCP服务"));
  const list = $(".ext-list", mcpGroup);
  if (list) {
    const servers = Array.isArray(cfg.servers) ? cfg.servers : [];
    if (!servers.length) {
      list.innerHTML = '<li class="ext-item" style="padding-left: 0; border-bottom: none;"><div class="ext-info"><h4>暂无 MCP 服务</h4><p>data/config/mcp.yaml</p></div><div class="toggle" data-mcp-global="true"></div></li>';
    } else {
      list.innerHTML = servers.map((server, index) => {
        const on = server?.enabled === false ? "false" : "true";
        return `<li class="ext-item" style="padding-left: 0; border-bottom: none;" data-mcp-edit-index="${index}"><div class="ext-info"><h4>${mcpServerTitle(server, index)}</h4><p>${mcpServerSubtitle(server)}</p></div><div class="toggle" data-on="${on}" data-mcp-index="${index}"></div></li>`;
      }).join("");
    }

    $$("[data-mcp-edit-index]", list).forEach((row) => {
      row.addEventListener("click", (event) => {
        if (event.target.closest(".toggle")) return;
        const index = Number(row.dataset.mcpEditIndex);
        openMcpServerEditor(servers[index], index);
      });
    });

    if (!servers.length) {
      list.addEventListener("click", (event) => {
        if (event.target.closest(".toggle")) return;
        openMcpServerEditor({}, null);
      }, { once: true });
    }

    $$("[data-mcp-index]", list).forEach((toggle) => {
      if (!toggle.classList.contains("toggle")) return;
      toggle.addEventListener("click", async (event) => {
        event.stopPropagation();
        const index = Number(toggle.dataset.mcpIndex);
        const next = toggle.dataset.on !== "true";
        try {
          const res = await ShinsekaiAPI.toggleMcpServer(index, next);
          backendState = { ...backendState, mcp_config: res.mcp_config || backendState?.mcp_config };
          hydrateMcpServices(backendState);
          notify(res.warning || res.message || "MCP 服务开关已保存");
        } catch (err) {
          notify(`MCP 服务开关失败：${err.message}`);
        }
      });
    });

    $$("[data-mcp-global]", list).forEach((toggle) => {
      toggle.dataset.on = cfg.enabled === false ? "false" : "true";
      toggle.addEventListener("click", async (event) => {
        event.stopPropagation();
        const next = toggle.dataset.on !== "true";
        try {
          const res = await ShinsekaiAPI.toggleMcpGlobal(next);
          backendState = { ...backendState, mcp_config: res.mcp_config || backendState?.mcp_config };
          hydrateMcpServices(backendState);
          notify(res.warning || res.message || "MCP 全局开关已保存");
        } catch (err) {
          notify(`MCP 全局开关失败：${err.message}`);
        }
      });
    });
  }

  const previewGroup = $$(".section-group", services)
    .find((group) => textOf($(".section-label", group)) === "工具预览");
  const previewList = $(".ext-list", previewGroup);
  if (previewList) {
    const servers = Array.isArray(cfg.servers) ? cfg.servers : [];
    const enabledServers = servers.filter((s) => s?.enabled !== false);
    previewList.innerHTML = enabledServers.length
      ? enabledServers.slice(0, 6).map((server, index) => `<li class="ext-item" style="padding:10px 0;"><div class="ext-info"><h4>${mcpServerTitle(server, index)}</h4><p>${mcpServerSubtitle(server)}</p></div></li>`).join("")
      : '<li class="ext-item" style="padding:10px 0;"><div class="ext-info"><h4>未启用 MCP 服务</h4><p>点击左侧 MCP 开关或打开 mcp.yaml</p></div></li>';
  }
}

function pluginDisplayName(plugin, index) {
  const settings = Array.isArray(plugin?.settings_contributions) ? plugin.settings_contributions : [];
  const tools = Array.isArray(plugin?.tools_contributions) ? plugin.tools_contributions : [];
  return plugin?.display_name
    || plugin?.plugin_name
    || settings.find((x) => x?.nav_label)?.nav_label
    || tools.find((x) => x?.title)?.title
    || plugin?.plugin_id
    || plugin?.entry
    || `插件 ${index + 1}`;
}

function pluginSubtitle(plugin) {
  const enabled = plugin?.enabled === false ? "未启用" : "已启用";
  const loaded = plugin?.loaded ? "已加载" : "未加载/待重启";
  const version = plugin?.plugin_version ? ` // v${plugin.plugin_version}` : "";
  const surfaces = [];
  if (plugin?.has_settings) surfaces.push("有设置页");
  if (plugin?.has_tools) surfaces.push("有工具页");
  const surfaceText = surfaces.length ? ` // ${surfaces.join(" / ")}` : "";
  return `${enabled} // ${loaded}${version}${surfaceText}`;
}

function pluginHasPanel(plugin) {
  return Boolean(
    plugin?.has_settings
    || plugin?.has_tools
    || (Array.isArray(plugin?.settings_contributions) && plugin.settings_contributions.length)
    || (Array.isArray(plugin?.tools_contributions) && plugin.tools_contributions.length)
  );
}

function pluginCatalogSubtitle(item) {
  const repo = item?.repo || "未声明仓库";
  const author = item?.author ? `作者：${item.author}` : "作者未知";
  return `${item?.status_label || "可安装"} // ${author} // ${repo}`;
}

function renderPluginCatalog(pluginCard) {
  const list = $("[data-plugin-catalog-list]", pluginCard);
  const status = $("[data-plugin-catalog-status]", pluginCard);
  if (!list) return;
  if (status) {
    if (pluginCatalogState.loading) status.textContent = "正在读取远程插件索引…";
    else if (pluginCatalogState.error) status.textContent = `读取失败：${pluginCatalogState.error}`;
    else if (pluginCatalogState.loaded) status.textContent = `已读取 ${pluginCatalogState.catalog.length} 个插件。`;
    else status.textContent = "尚未读取远程插件索引。";
  }
  if (pluginCatalogState.loading) {
    list.innerHTML = '<li class="ext-item" style="padding-left:0;"><div class="ext-info"><h4>读取中</h4><p>正在连接插件市场。</p></div></li>';
    return;
  }
  if (pluginCatalogState.error) {
    list.innerHTML = `<li class="ext-item" style="padding-left:0;"><div class="ext-info"><h4>市场读取失败</h4><p>${escapeHtml(pluginCatalogState.error)}</p></div><button class="btn-action" data-plugin-catalog-refresh>重试</button></li>`;
    return;
  }
  if (!pluginCatalogState.catalog.length) {
    list.innerHTML = '<li class="ext-item" style="padding-left:0;"><div class="ext-info"><h4>暂无市场数据</h4><p>点击刷新市场读取远程 plugins.json。</p></div></li>';
    return;
  }
  list.innerHTML = pluginCatalogState.catalog.map((item, index) => {
    const github = item.github_url
      ? `<a class="btn-action" href="${escapeHtml(item.github_url)}" target="_blank" rel="noreferrer" style="text-decoration:none;">GitHub</a>`
      : '<button class="btn-action" disabled>GitHub</button>';
    const disabled = item.repo ? "" : " disabled";
    const overwrite = item.downloaded || item.installed ? "true" : "false";
    return `<li class="ext-item" style="padding-left:0;" data-catalog-index="${index}">
      <div class="ext-info"><h4>${escapeHtml(item.name || item.repo || `插件 ${index + 1}`)}</h4><p>${escapeHtml(pluginCatalogSubtitle(item))}</p><p>${escapeHtml(item.description || "暂无说明。")}</p></div>
      <div style="display:flex; gap:8px; align-items:center; flex-wrap:wrap;">${github}<button class="btn-action" data-plugin-catalog-install="${index}" data-overwrite="${overwrite}"${disabled}>${escapeHtml(item.action_label || "安装")}</button></div>
    </li>`;
  }).join("");
}

async function loadPluginCatalog({ force = false } = {}) {
  const services = $("#screen-services");
  const pluginCard = $$("#screen-services .center-grid > .detail-card")
    .find((card) => textOf($(".char-name", card)).includes("插件服务"));
  if (!pluginCard || (pluginCatalogState.loaded && !force) || pluginCatalogState.loading) return;
  pluginCatalogState = { ...pluginCatalogState, loading: true, error: "" };
  renderPluginCatalog(pluginCard);
  try {
    const res = await ShinsekaiAPI.listPluginCatalog();
    pluginCatalogState = {
      catalog: Array.isArray(res.catalog) ? res.catalog : [],
      error: res.error || "",
      loaded: true,
      loading: false
    };
  } catch (err) {
    pluginCatalogState = { catalog: [], error: err.message, loaded: true, loading: false };
  }
  renderPluginCatalog(pluginCard);
  if (services) hydrateStatusPanels(backendState || {});
}

function switchPluginPanel(pluginCard, tab) {
  $$("[data-plugin-panel]", pluginCard).forEach((panel) => {
    panel.hidden = panel.dataset.pluginPanel !== tab;
  });
  $$("[data-plugin-tab]", pluginCard).forEach((btn) => {
    const active = btn.dataset.pluginTab === tab;
    btn.classList.toggle("active", active);
    btn.style.background = active ? "black" : "";
    btn.style.color = active ? "white" : "";
  });
  if (tab === "discover") loadPluginCatalog();
}

function hydratePlugins(state) {
  const services = $("#screen-services");
  const plugins = Array.isArray(state?.plugins) ? state.plugins : [];
  const pluginCard = $$("#screen-services .center-grid > .detail-card")
    .find((card) => textOf($(".char-name", card)).includes("插件服务"));
  const list = $("[data-plugin-manage-list]", pluginCard) || $(".ext-list", pluginCard);
  if (!list) return;

  if (!plugins.length) {
    list.innerHTML = '<li class="ext-item" style="padding-left: 0;"><div class="ext-info"><h4>暂无插件清单</h4><p>data/config/plugins.yaml</p></div><button class="btn-action" data-plugin-action="manifest">打开清单</button></li>';
  } else {
    list.innerHTML = plugins.map((plugin, index) => {
      const entry = String(plugin?.entry || "");
      const enabled = plugin?.enabled !== false;
      const settingsButton = pluginHasPanel(plugin)
        ? `<button class="btn-action" data-plugin-action="settings" data-entry="${encodeURIComponent(entry)}">设置</button>`
        : "";
      return `<li class="ext-item" style="padding-left: 0;" data-plugin-entry="${encodeURIComponent(entry)}"><div class="ext-info"><h4>${escapeHtml(pluginDisplayName(plugin, index))}</h4><p>${escapeHtml(pluginSubtitle(plugin))}</p></div><div style="display:flex; gap:8px; align-items:center;">${settingsButton}<button class="btn-action" data-plugin-action="toggle" data-enabled="${enabled ? "true" : "false"}" data-entry="${encodeURIComponent(entry)}">${enabled ? "禁用" : "启用"}</button></div></li>`;
    }).join("");
  }

  list.onclick = async (event) => {
    const btn = event.target.closest("[data-plugin-action]");
    if (!btn) {
      const row = event.target.closest("[data-plugin-entry]");
      if (row) {
        const entry = decodeURIComponent(row.dataset.pluginEntry || "");
        const plugin = (backendState?.plugins || []).find((p) => String(p.entry || "") === entry) || { entry };
        if (pluginHasPanel(plugin)) openPluginDetailEditor(plugin);
      }
      return;
    }
    const action = btn.dataset.pluginAction;
    const entry = decodeURIComponent(btn.dataset.entry || "");
    try {
      if (action === "manifest") {
        const res = await ShinsekaiAPI.openPluginManifest();
        notify(res.message || "已打开插件清单");
        return;
      }
      if (action === "settings") {
        const plugin = (backendState?.plugins || []).find((p) => String(p.entry || "") === entry) || { entry };
        openPluginDetailEditor(plugin);
        return;
      }
      if (action === "toggle") {
        const next = btn.dataset.enabled !== "true";
        const res = await ShinsekaiAPI.togglePlugin(entry, next);
        backendState = { ...backendState, plugins: res.plugins || backendState?.plugins };
        hydratePlugins(backendState);
        notify(res.message || "插件状态已保存");
      }
    } catch (err) {
      notify(`插件操作失败：${err.message}`);
    }
  };

  const refreshButton = findButton("刷新索引", pluginCard);
  if (refreshButton) {
    refreshButton.onclick = async () => {
      try {
        const res = await ShinsekaiAPI.listPlugins();
        backendState = { ...backendState, plugins: res.plugins || [] };
        hydratePlugins(backendState);
        notify(`插件状态已刷新：${res?.plugins?.length ?? 0} 个插件`);
      } catch (err) {
        notify(`刷新失败：${err.message}`);
      }
    };
  }

  renderPluginCatalog(pluginCard);

  $$("[data-plugin-tab]", pluginCard).forEach((btn) => {
    btn.onclick = () => switchPluginPanel(pluginCard, btn.dataset.pluginTab || "manage");
  });
  $$("[data-plugin-catalog-refresh]", pluginCard).forEach((btn) => {
    btn.onclick = () => loadPluginCatalog({ force: true });
  });
  const catalogList = $("[data-plugin-catalog-list]", pluginCard);
  if (catalogList) {
    catalogList.onclick = async (event) => {
      const refresh = event.target.closest("[data-plugin-catalog-refresh]");
      if (refresh) {
        loadPluginCatalog({ force: true });
        return;
      }
      const btn = event.target.closest("[data-plugin-catalog-install]");
      if (!btn) return;
      const index = Number(btn.dataset.pluginCatalogInstall);
      const item = pluginCatalogState.catalog[index];
      if (!item) return;
      const verb = btn.dataset.overwrite === "true" ? "更新" : "安装";
      if (!window.confirm(`确认${verb}插件「${item.name || item.repo}」？这会下载 GitHub 插件并安装 requirements.txt 依赖。`)) return;
      btn.disabled = true;
      btn.textContent = `${verb}中`;
      try {
        const res = await ShinsekaiAPI.installCatalogPlugin({
          name: item.name,
          repo: item.repo,
          entry: item.entry,
          overwrite: btn.dataset.overwrite === "true"
        });
        backendState = { ...backendState, plugins: res.plugins || backendState?.plugins };
        pluginCatalogState = {
          catalog: Array.isArray(res.catalog) ? res.catalog : pluginCatalogState.catalog,
          error: res.error || "",
          loaded: true,
          loading: false
        };
        hydratePlugins(backendState);
        notify(res.message || "插件已安装");
      } catch (err) {
        notify(`插件安装失败：${err.message}`);
        btn.disabled = false;
        btn.textContent = verb;
      }
    };
  }
}


function hydrateRealProjectState(state) {
  hydrateApiConfig(state?.api_config);
  hydrateMcpServices(state);
  hydratePlugins(state);
  hydrateCharacters(state);
  hydrateBackgrounds(state);
  hydrateTemplatesAndHistories(state);
  hydrateLaunchSummary(state);
  hydrateLaunchPreview(state);
  hydrateStatusPanels(state);
  hydrateSessionPlugins(state);
}

async function loadTemplateIntoSession(name, { silent = false, replaceBlankOnly = false } = {}) {
  const root = $("#screen-sessions");
  if (!name) {
    if (!silent) notify("没有可加载的模板文件");
    return null;
  }
  const res = await ShinsekaiAPI.loadTemplate(name);
  currentTemplateName = res.name || name;
  const rawTemplate = res?.system_template ? "" : await loadRawTemplateText(currentTemplateName);
  const loaded = normalizeLoadedTemplate(res, rawTemplate);
  setCurrentSystemTemplate(loaded.system);

  const sessionNameInput = findFieldControl("会话名称", root) || findFieldControl("会话昵称", root);
  const scenarioInput = findFieldControl("用户情景", root);
  const displayName = templateDisplayName(currentTemplateName);
  const scenario = loaded.scenario;

  if (sessionNameInput && (!replaceBlankOnly || isBlankSessionName(sessionNameInput.value))) {
    sessionNameInput.value = displayName || currentTemplateName;
  }
  if (scenarioInput && loaded.legacyCombined && !replaceBlankOnly) {
    scenarioInput.value = "";
  }
  if (scenarioInput && scenario && !scenario.startsWith("加载失败") && (!replaceBlankOnly || isBlankScenario(scenarioInput.value))) {
    scenarioInput.value = scenario;
  }

  const preview = $("#screen-sessions .detail-card.wide-card:last-child .detail-body .muted-line");
  if (preview) {
    const hasScenario = !!(scenario && !scenario.startsWith("加载失败"));
    preview.textContent = currentSystemTemplate
      ? `已加载模板：${currentTemplateName}${loaded.legacyCombined ? "（旧版整段模板）" : ""}`
      : `已加载模板：${currentTemplateName}${hasScenario ? "（仅用户情景）" : "（无系统段）"}`;
  }
  refreshAllDerivedState();
  if (!silent) notify(`已加载模板：${currentTemplateName}`);
  return res;
}

async function loadSelectedTemplate() {
  const root = $("#screen-sessions");
  const select = $("aside .section-group select", root);
  return loadTemplateIntoSession(select?.value, { silent: false, replaceBlankOnly: false });
}

async function saveCurrentTemplate(copy = false) {
  const session = collectSessionBuilder();
  const filename = copy ? `${session.session_name || currentTemplateName || "template"}_copy` : (session.session_name || currentTemplateName || "template");
  const res = await ShinsekaiAPI.saveTemplate({
    filename,
    session_name: filename,
    scenario: session.scenario,
    system_template: currentSystemTemplate
  });
  notify(res?.message || "模板已保存");
}

function buildFreshHistoryFilePath() {
  const stamp = new Date().toISOString().replace(/\D/g, "").slice(0, 14);
  const suffix = Math.random().toString(36).slice(2, 8);
  return `data/chat_history/webui_${stamp}_${suffix}.json`;
}



function coerceEditorValue(raw, original) {
  if (original === null || original === undefined) return raw;
  if (typeof original === "number") return Number(raw || 0);
  if (typeof original === "boolean") return raw === true || raw === "true" || raw === "是" || raw === "on";
  if (Array.isArray(original) || typeof original === "object") {
    try { return JSON.parse(raw || (Array.isArray(original) ? "[]" : "{}")); }
    catch (err) { throw new Error(`JSON 格式错误：${err.message}`); }
  }
  return raw;
}

function jsonText(value) {
  if (value === undefined) return "";
  if (typeof value === "object") return JSON.stringify(value, null, 2);
  return String(value ?? "");
}

function fieldHtml(field) {
  const label = field.label || field.key;
  const value = field.value;
  if (field.type === "select") {
    const options = (field.options || []).map((opt) => {
      const v = typeof opt === "string" ? opt : opt.value;
      const text = typeof opt === "string" ? opt : opt.label;
      return `<option value="${String(v).replaceAll('"', '&quot;')}" ${String(v) === String(value) ? "selected" : ""}>${text}</option>`;
    }).join("");
    return `<div class="field" data-editor-key="${field.key}"><label>${label}</label><select>${options}</select></div>`;
  }
  if (field.type === "textarea" || Array.isArray(value) || (value && typeof value === "object")) {
    return `<div class="field" data-editor-key="${field.key}"><label>${label}</label><textarea>${jsonText(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;")}</textarea></div>`;
  }
  return `<div class="field" data-editor-key="${field.key}"><label>${label}</label><input value="${jsonText(value).replaceAll('"', '&quot;')}"></div>`;
}

function openEditorModal({ title, subtitle = "详细设置", fields = [], onSave, extraButtons = [] }) {
  const modal = $("#tool-modal");
  const titleNode = $("#modal-title");
  const subtitleNode = $("#modal-subtitle");
  const content = $("#modal-content");
  if (!modal || !titleNode || !subtitleNode || !content) return;

  titleNode.textContent = title;
  subtitleNode.textContent = subtitle;
  const extras = extraButtons.map((b, index) => `<button class="btn-action" data-extra-index="${index}">${b.label}</button>`).join("");
  content.innerHTML = `${fields.map(fieldHtml).join("")}<div class="split-row"><button class="btn-action" data-editor-save="true">保存</button>${extras}</div>`;
  modal.classList.add("active");

  content.onclick = async (event) => {
    const saveBtn = event.target.closest("[data-editor-save]");
    const extraBtn = event.target.closest("[data-extra-index]");
    if (!saveBtn && !extraBtn) return;
    try {
      if (extraBtn) {
        const index = Number(extraBtn.dataset.extraIndex);
        await extraButtons[index]?.onClick?.();
        return;
      }
      const payload = {};
      fields.forEach((field) => {
        const root = content.querySelector(`[data-editor-key="${CSS.escape(field.key)}"]`);
        const control = root?.querySelector("input, select, textarea");
        if (!control) return;
        payload[field.key] = coerceEditorValue(control.value, field.value);
      });
      const result = await onSave(payload);
      notify(result?.message || "已保存");
      modal.classList.remove("active");
      await hydrateFromBackend();
    } catch (err) {
      notify(`保存失败：${err.message}`);
    }
  };
}

function shouldHideEditorField(key) {
  const normalized = String(key || "").trim().toLowerCase();
  return !normalized
    || normalized.startsWith("_")
    || normalized === "html"
    || normalized.startsWith("debug")
    || normalized.includes("mock");
}

function fieldsFromObject(obj, preferred = []) {
  const seen = new Set();
  const fields = [];
  [...preferred, ...Object.keys(obj || {})].forEach((key) => {
    if (seen.has(key) || shouldHideEditorField(key)) return;
    seen.add(key);
    fields.push({ key, label: key, value: obj?.[key] });
  });
  return fields;
}

function selectedCharacterFromEditor() {
  const name = getField("人物名称", $("#screen-characters"));
  return normalizeCharacters(backendState).find((c) => c.name === name) || firstCharacter() || {};
}

function selectedBackgroundFromEditor() {
  const name = getField("场景名称", $("#screen-scenes"));
  return normalizeBackgrounds(backendState).find((b) => b.name === name) || firstBackground() || {};
}

function openCharacterFullEditor(character = selectedCharacterFromEditor()) {
  const base = {
    name: "", color: "#C28ED1", sprite_prefix: "", sprites: [], character_setting: "",
    sprite_scale: 1.0, emotion_tags: "", gpt_model_path: "", sovits_model_path: "",
    refer_audio_path: "", prompt_text: "", prompt_lang: "", speech_speed: 1.0, speech_volume: 1.0,
    ...(character || {})
  };
  openEditorModal({
    title: `角色详细设置：${base.name || "新角色"}`,
    subtitle: "保存后写入 data/config/characters.yaml",
    fields: fieldsFromObject(base, ["name", "color", "sprite_prefix", "character_setting", "sprite_scale", "emotion_tags", "sprites", "gpt_model_path", "sovits_model_path", "refer_audio_path", "prompt_text", "prompt_lang", "speech_speed", "speech_volume"]),
    onSave: (payload) => ShinsekaiAPI.saveCharacter(payload.name || base.name, payload),
    extraButtons: [
      { label: "打开 data 目录", onClick: () => ShinsekaiAPI.openPath({ path: "data" }) },
      ...(base.name && base.name !== "新角色" ? [{ label: "删除人物", onClick: async () => { await ShinsekaiAPI.deleteCharacter(base.name); notify("人物已删除"); await hydrateFromBackend(); $("#tool-modal")?.classList.remove("active"); } }] : [])
    ]
  });
}

function openCharacterVoiceEditor() {
  const c = selectedCharacterFromEditor();
  const fields = ["name", "gpt_model_path", "sovits_model_path", "refer_audio_path", "prompt_text", "prompt_lang", "speech_speed", "speech_volume"].map((key) => ({ key, label: key, value: c?.[key] ?? "" }));
  openEditorModal({
    title: `语音绑定：${c?.name || "角色"}`,
    subtitle: "GPT-SoVITS / 参考音频 / 语速音量",
    fields,
    onSave: (payload) => ShinsekaiAPI.saveCharacter(payload.name || c.name, { ...c, ...payload })
  });
}

function openCharacterSpritesEditor() {
  const c = selectedCharacterFromEditor();
  openEditorModal({
    title: `立绘与情绪：${c?.name || "角色"}`,
    subtitle: "sprites 为 JSON 数组；emotion_tags 为原项目情绪标注文本",
    fields: [
      { key: "name", label: "name", value: c?.name || "" },
      { key: "sprite_prefix", label: "sprite_prefix", value: c?.sprite_prefix || "" },
      { key: "sprites", label: "sprites", value: c?.sprites || [] },
      { key: "emotion_tags", label: "emotion_tags", value: c?.emotion_tags || "", type: "textarea" },
      { key: "sprite_scale", label: "sprite_scale", value: c?.sprite_scale ?? 1.0 },
    ],
    onSave: (payload) => ShinsekaiAPI.saveCharacter(payload.name || c.name, { ...c, ...payload })
  });
}

function openBackgroundFullEditor(bg = selectedBackgroundFromEditor()) {
  const base = { name: "", sprite_prefix: "", sprites: [], bg_tags: "", bgm_list: [], bgm_tags: "", ...(bg || {}) };
  openEditorModal({
    title: `场景详细设置：${base.name || "新场景"}`,
    subtitle: "保存后写入 data/config/background.yaml",
    fields: fieldsFromObject(base, ["name", "sprite_prefix", "sprites", "bg_tags", "bgm_list", "bgm_tags"]),
    onSave: (payload) => ShinsekaiAPI.saveBackground(payload.name || base.name, payload),
    extraButtons: [
      { label: "打开 data 目录", onClick: () => ShinsekaiAPI.openPath({ path: "data" }) },
      ...(base.name && base.name !== "新场景" ? [{ label: "删除场景", onClick: async () => { await ShinsekaiAPI.deleteBackground(base.name); notify("场景已删除"); await hydrateFromBackend(); $("#tool-modal")?.classList.remove("active"); } }] : [])
    ]
  });
}

function openSystemConfigEditor() {
  const sys = backendState?.system_config || {};
  openEditorModal({
    title: "系统详细设置",
    subtitle: "保存后写入 data/config/system_config.yaml",
    fields: fieldsFromObject(sys, ["ui_language", "voice_language", "asr_provider", "asr_language", "asr_whisper_model_size", "asr_whisper_device", "asr_whisper_compute_type", "music_volumn", "theme_color", "bgm_path", "background_path", "live_room_id", "base_font_size_px"]),
    onSave: (payload) => ShinsekaiAPI.saveSystemConfig(payload)
  });
}

function openAdapterExtraEditor(kind, provider) {
  const api = backendState?.api_config || {};
  const key = `${kind}_extra_configs`;
  const current = api?.[key]?.[provider] || {};
  openEditorModal({
    title: `${kind.toUpperCase()} 扩展参数：${provider || "未选择"}`,
    subtitle: `保存到 api.yaml 的 ${key}.${provider}`,
    fields: [{ key: "data", label: "extra config JSON", value: current }],
    onSave: (payload) => ShinsekaiAPI.saveAdapterExtra({ kind, provider, data: payload.data || {} })
  });
}

function openMcpServerEditor(server = {}, index = null) {
  const row = {
    enabled: server?.enabled !== false,
    name_prefix: server?.name_prefix || "",
    transport: server?.transport || "sse",
    url: server?.url || "",
    headers: server?.headers || {},
    command: server?.command || "",
    args: server?.args || [],
    call_timeout: server?.call_timeout || "",
  };
  openEditorModal({
    title: index === null ? "新增 MCP 服务" : `编辑 MCP 服务 #${index + 1}`,
    subtitle: "保存后写入 data/config/mcp.yaml 并尝试重新加载工具",
    fields: [
      { key: "enabled", label: "enabled", value: row.enabled, type: "select", options: [{ value: "true", label: "true" }, { value: "false", label: "false" }] },
      { key: "name_prefix", label: "name_prefix", value: row.name_prefix },
      { key: "transport", label: "transport", value: row.transport, type: "select", options: ["sse", "stdio"] },
      { key: "url", label: "url", value: row.url },
      { key: "headers", label: "headers", value: row.headers },
      { key: "command", label: "command", value: row.command },
      { key: "args", label: "args", value: row.args },
      { key: "call_timeout", label: "call_timeout", value: row.call_timeout },
    ],
    onSave: (payload) => {
      payload.enabled = payload.enabled === true || payload.enabled === "true";
      return index === null ? ShinsekaiAPI.addMcpServer(payload) : ShinsekaiAPI.updateMcpServer(index, payload);
    },
    extraButtons: [
      ...(index === null ? [] : [{ label: "删除", onClick: async () => { await ShinsekaiAPI.deleteMcpServer(index); notify("MCP 服务已删除"); await hydrateFromBackend(); $("#tool-modal")?.classList.remove("active"); } }]),
      { label: "打开 mcp.yaml", onClick: () => ShinsekaiAPI.openMcpConfig() }
    ]
  });
}

async function openPluginDetailEditor(plugin) {
  const row = { ...(plugin || {}) };
  const modal = $("#tool-modal");
  const titleNode = $("#modal-title");
  const subtitleNode = $("#modal-subtitle");
  const content = $("#modal-content");
  if (!modal || !titleNode || !subtitleNode || !content) return;

  titleNode.textContent = `插件设置：${pluginDisplayName(row, 0)}`;
  subtitleNode.textContent = "正在读取插件自带设置面板…";
  content.innerHTML = '<p class="muted-line">正在加载插件设置…</p>';
  modal.classList.add("active");

  let detail = null;
  try {
    const res = await ShinsekaiAPI.getPluginWebDetail(row.entry || "");
    detail = res.plugin || {};
  } catch (err) {
    notify(`插件设置读取失败：${err.message}`);
    detail = { manifest: row };
  }

  const manifest = { ...row, ...(detail?.manifest || {}) };
  const configSchema = detail?.web_config_schema || null;
  const dataInfo = detail?.data || {};
  titleNode.textContent = `插件设置：${pluginDisplayName(manifest, 0)}`;

  if (!configSchema || !Array.isArray(configSchema.fields) || !configSchema.fields.length) {
    subtitleNode.textContent = "这个插件没有可 Web 渲染的自带设置模型";
    content.innerHTML = `
      <div class="detail-card wide-card">
        <div class="detail-head"><div><h3 class="char-name">${escapeHtml(pluginDisplayName(manifest, 0))}</h3><p class="muted-line">未找到 config_model.py 或可转换的设置字段。</p></div></div>
        <div class="detail-body input-stack">
          <p class="muted-line">这个 Web UI 现在只渲染插件自带设置面板，不再展示插件清单、README、文件索引等调试区。该插件没有声明可自动转成 Web 表单的配置模型时，可以临时打开原生 PySide 面板。</p>
          <div class="split-row"><button class="btn-action" data-plugin-native-fallback>打开原生插件设置</button></div>
        </div>
      </div>
    `;
    content.onclick = async (event) => {
      if (event.target.closest("[data-plugin-native-fallback]")) {
        const res = await ShinsekaiAPI.openPluginSettings(manifest.entry);
        notify(res.message || "已打开原生插件设置窗口");
      }
    };
    return;
  }

  subtitleNode.textContent = `只渲染插件自带面板 · 保存到 ${configSchema.path || "config.json"}`;
  const values = configSchema.values || {};
  const fields = configSchema.fields || [];
  const intro = Array.isArray(configSchema.intro) ? configSchema.intro.filter(Boolean) : [];
  const schemaKind = configSchema.kind || configSchema.save_mode || "";

  function inputValue(key, fallback = "") {
    const value = values[key];
    if (value === undefined || value === null) return fallback;
    return value;
  }

  function numberAttrs(field) {
    const attrs = [];
    if (field.min !== undefined && field.min !== null) attrs.push(`min="${escapeHtml(field.min)}"`);
    if (field.max !== undefined && field.max !== null) attrs.push(`max="${escapeHtml(field.max)}"`);
    if (field.step !== undefined && field.step !== null) attrs.push(`step="${escapeHtml(field.step)}"`);
    return attrs.join(" ");
  }

  function renderConfigField(field) {
    const key = field.name;
    const label = field.label || key;
    const typeText = String(field.type || "").toLowerCase();
    const uiType = String(field.ui || "").toLowerCase();
    const value = inputValue(key, field.default ?? "");
    const help = field.help ? `<p class="muted-line" style="white-space:pre-line; margin-top:6px;">${escapeHtml(field.help)}</p>` : "";
    const placeholder = field.placeholder ? ` placeholder="${escapeHtml(field.placeholder)}"` : "";
    const isJson = typeText.includes("json") || uiType === "json";
    const isWide = isJson || uiType === "textarea" || field.multiline;
    const fieldClass = `field${isWide ? " wide-field" : ""}`;

    if (uiType === "color" || typeText.includes("color")) {
      const color = /^#[0-9a-f]{6}$/i.test(String(value || "")) ? value : (field.default || "#ffffff");
      return `<div class="${fieldClass}"><label>${escapeHtml(label)}</label><input type="color" data-plugin-config-field="${escapeHtml(key)}" data-plugin-config-type="str" value="${escapeHtml(color)}">${help}</div>`;
    }

    if (Array.isArray(field.choices) && field.choices.length) {
      const options = field.choices.map((choice, i) => {
        const labelText = (field.labels && field.labels[i]) || choice;
        return `<option value="${escapeHtml(choice)}" ${String(choice) === String(value) ? "selected" : ""}>${escapeHtml(labelText)}</option>`;
      }).join("");
      const valueType = typeText.includes("int") ? "int" : (typeText.includes("float") ? "float" : "str");
      return `<div class="${fieldClass}"><label>${escapeHtml(label)}</label><select data-plugin-config-field="${escapeHtml(key)}" data-plugin-config-type="select" data-plugin-config-value-type="${valueType}">${options}</select>${help}</div>`;
    }

    if (typeText.includes("bool")) {
      return `<div class="${fieldClass}"><label>${escapeHtml(label)}</label><div class="check-row" data-plugin-bool-row><span>${inputValue(key) ? "已启用" : "已关闭"}</span><button class="toggle" data-plugin-config-field="${escapeHtml(key)}" data-plugin-config-type="bool" data-value="${value ? "true" : "false"}"></button></div>${help}</div>`;
    }

    if (typeText.includes("float") || typeText.includes("int")) {
      const step = field.step ?? (typeText.includes("int") ? "1" : "0.01");
      const dataType = typeText.includes("int") ? "int" : "float";
      const attrs = numberAttrs({ ...field, step });
      return `<div class="${fieldClass}"><label>${escapeHtml(label)}</label><input type="number" ${attrs} data-plugin-config-field="${escapeHtml(key)}" data-plugin-config-type="${dataType}" value="${escapeHtml(value)}">${help}</div>`;
    }

    if (isJson) {
      return `<div class="${fieldClass}"><label>${escapeHtml(label)}</label><textarea data-plugin-config-field="${escapeHtml(key)}" data-plugin-config-type="json"${placeholder}>${escapeHtml(jsonText(value || field.default || {}))}</textarea>${help}</div>`;
    }

    const longText = uiType === "textarea" || field.multiline || String(value || "").length > 80 || key.startsWith("question");
    if (longText) {
      return `<div class="${fieldClass}"><label>${escapeHtml(label)}</label><textarea data-plugin-config-field="${escapeHtml(key)}" data-plugin-config-type="str"${placeholder}>${escapeHtml(value)}</textarea>${help}</div>`;
    }
    return `<div class="${fieldClass}"><label>${escapeHtml(label)}</label><input data-plugin-config-field="${escapeHtml(key)}" data-plugin-config-type="str" value="${escapeHtml(value)}"${placeholder}>${help}</div>`;
  }

  let lastSection = "";
  const fieldsHtml = fields.map((field) => {
    const section = String(field.section || "");
    const header = section && section !== lastSection
      ? `<span class="section-label plugin-section-label">${escapeHtml(section)}</span>`
      : "";
    lastSection = section;
    return `${header}${renderConfigField(field)}`;
  }).join("");

  const introHtml = intro.length
    ? `<div class="detail-card wide-card"><div class="detail-body input-stack">${intro.map((p) => `<p class="muted-line" style="white-space:pre-line;">${escapeHtml(p)}</p>`).join("")}</div></div>`
    : "";

  content.innerHTML = `
    ${introHtml}
    <div class="detail-card wide-card">
      <div class="detail-head">
        <div><h3 class="char-name">${escapeHtml(configSchema.title || pluginDisplayName(manifest, 0))}</h3><p class="muted-line">${escapeHtml(configSchema.path || "config.json")}</p></div>
        <span class="status-pill ${configSchema.exists ? "status-available" : "status-unconfigured"}">${configSchema.exists ? "已读取" : "默认值"}</span>
      </div>
      <div class="detail-body input-stack">
        <div class="mini-grid">${fieldsHtml}</div>
        <div class="split-row"><button class="btn-action" data-plugin-save-config>保存设置</button></div>
      </div>
    </div>
  `;

  content.querySelectorAll('[data-plugin-config-type="bool"]').forEach((toggle) => {
    setToggleState(toggle, toggle.dataset.value === "true");
    const row = toggle.closest("[data-plugin-bool-row]");
    if (row) row.querySelector("span").textContent = toggle.dataset.value === "true" ? "已启用" : "已关闭";
  });

  content.onclick = async (event) => {
    try {
      const boolToggle = event.target.closest('[data-plugin-config-type="bool"]');
      const boolRow = event.target.closest("[data-plugin-bool-row]");
      const toggle = boolToggle || boolRow?.querySelector('[data-plugin-config-type="bool"]');
      if (toggle) {
        const next = toggle.dataset.value !== "true";
        toggle.dataset.value = next ? "true" : "false";
        setToggleState(toggle, next);
        const row = toggle.closest("[data-plugin-bool-row]");
        if (row) row.querySelector("span").textContent = next ? "已启用" : "已关闭";
        return;
      }

      if (event.target.closest("[data-plugin-save-config]")) {
        if (!configSchema.path) throw new Error("没有可保存的插件配置路径");
        const payload = {};
        content.querySelectorAll("[data-plugin-config-field]").forEach((node) => {
          const key = node.dataset.pluginConfigField;
          const type = node.dataset.pluginConfigType || "str";
          const valueType = node.dataset.pluginConfigValueType || type;
          if (!key) return;
          if (type === "bool") payload[key] = node.dataset.value === "true";
          else if (type === "json") payload[key] = node.value.trim() ? JSON.parse(node.value) : {};
          else if (type === "int" || valueType === "int") payload[key] = Number.parseInt(node.value || "0", 10);
          else if (type === "float" || valueType === "float") payload[key] = Number.parseFloat(node.value || "0");
          else payload[key] = node.value || "";
        });
        if (schemaKind) payload.__web_schema_kind = schemaKind;
        const res = await ShinsekaiAPI.savePluginWebFile({ path: configSchema.path, content: JSON.stringify(payload, null, 2) });
        notify(res.message || "插件设置已保存");
        return;
      }
    } catch (err) {
      notify(`插件设置操作失败：${err.message}`);
    }
  };
}

function openSystemTemplateEditor() {
  const session = collectSessionBuilder();
  const filename = currentTemplateName || `${session.session_name || "template"}.txt`;
  openEditorModal({
    title: "系统模板完整编辑",
    subtitle: "编辑后会写入 data/character_templates；用户情景与系统模板会按原项目格式保存",
    fields: [
      { key: "filename", label: "模板文件名", value: filename },
      { key: "session_name", label: "会话名称", value: session.session_name || templateDisplayName(filename) },
      { key: "scenario", label: "用户情景", value: session.scenario || "", type: "textarea" },
      { key: "system_template", label: "系统模板", value: currentSystemTemplate || session.system_template || "", type: "textarea" }
    ],
    onSave: async (payload) => {
      currentTemplateName = payload.filename || filename;
      setCurrentSystemTemplate(payload.system_template || "");
      setField("会话名称", payload.session_name || templateDisplayName(currentTemplateName), $("#screen-sessions"));
      setField("用户情景", payload.scenario || "", $("#screen-sessions"));
      const res = await ShinsekaiAPI.saveTemplate({
        filename: currentTemplateName,
        session_name: payload.session_name || templateDisplayName(currentTemplateName),
        scenario: payload.scenario || "",
        system_template: currentSystemTemplate
      });
      await hydrateFromBackend();
      return res;
    }
  });
}

function wireDetailedSettingsPanels() {
  const services = $("#screen-services");
  $$(".detail-card", services).forEach((card) => {
    const title = textOf($(".char-name", card));
    const head = $(".detail-head", card) || card;
    head.addEventListener("click", (event) => {
      if (event.target.closest("button, input, select, textarea")) return;
      if (title.includes("LLM")) openAdapterExtraEditor("llm", normalizeLlmProviderValue(getField("供应商", services)));
      else if (title.includes("TTS")) openAdapterExtraEditor("tts", getField("TTS 引擎", services));
      else if (title.includes("ASR")) openAdapterExtraEditor("asr", getField("识别引擎", services));
      else if (title.includes("Comfy") || title.includes("T2I")) openAdapterExtraEditor("t2i", getField("生图引擎", services));
    });
  });

  findButton("绑定语音", $("#screen-characters"))?.addEventListener("click", openCharacterVoiceEditor);
  findButton("保存情绪标签", $("#screen-characters"))?.addEventListener("click", openCharacterSpritesEditor);
  findButton("上传立绘", $("#screen-characters"))?.addEventListener("click", openCharacterSpritesEditor);
  $$("#screen-characters button").filter((btn) => textOf(btn).includes("记忆")).forEach((btn) => {
    btn.addEventListener("click", () => openCharacterFullEditor(selectedCharacterFromEditor()));
  });

  findButton("上传图片", $("#screen-scenes"))?.addEventListener("click", () => openBackgroundFullEditor());
  findButton("保存说明", $("#screen-scenes"))?.addEventListener("click", () => openBackgroundFullEditor());
  findButton("上传BGM", $("#screen-scenes"))?.addEventListener("click", () => openBackgroundFullEditor());
  findButton("保存描述", $("#screen-scenes"))?.addEventListener("click", () => openBackgroundFullEditor());
  findButton("批量删除", $("#screen-scenes"))?.addEventListener("click", () => openBackgroundFullEditor());

  findButton("展开编辑", $("#screen-sessions"))?.addEventListener("click", openSystemTemplateEditor);
}


function wireMiscStateButtons() {
  findButton("一键下载并解压推荐整合包", $("#screen-services"))?.addEventListener("click", async () => {
    try { const res = await ShinsekaiAPI.openPath({ path: "data" }); notify(res.message || "已打开 data 目录"); }
    catch (err) { notify(`打开目录失败：${err.message}`); }
  });

  ["社区角色资源", "上传角色资源", "导入 .char", "导出选中角色"].forEach((label) => {
    findButton(label, $("#screen-characters"))?.addEventListener("click", async () => {
      try { await ShinsekaiAPI.openPath({ path: label.includes("导出") ? "output" : "data" }); }
      catch (err) { notify(`${label} 失败：${err.message}`); }
    });
  });
  findButton("+ 新建角色", $("#screen-characters"))?.addEventListener("click", () => openCharacterFullEditor({ name: "新角色", color: "#C28ED1", sprite_prefix: "new_character", sprites: [], character_setting: "" }));
  findButton("刷新记忆", $("#screen-characters"))?.addEventListener("click", () => openCharacterFullEditor(selectedCharacterFromEditor()));
  findButton("新增记忆", $("#screen-characters"))?.addEventListener("click", () => openCharacterFullEditor(selectedCharacterFromEditor()));

  ["社区背景资源", "上传背景资源", "导入 .bg", "导出场景"].forEach((label) => {
    findButton(label, $("#screen-scenes"))?.addEventListener("click", async () => {
      try { await ShinsekaiAPI.openPath({ path: label.includes("导出") ? "output" : "data" }); }
      catch (err) { notify(`${label} 失败：${err.message}`); }
    });
  });
  findButton("+ 新建场景", $("#screen-scenes"))?.addEventListener("click", () => openBackgroundFullEditor({ name: "新场景", sprite_prefix: "new_background", sprites: [], bg_tags: "", bgm_list: [], bgm_tags: "" }));
  findButton("替换场景", $("#screen-scenes"))?.addEventListener("click", () => {
    document.querySelector('[data-target="scenes"]')?.click();
  });

  findButton("打开历史文件位置", $("#screen-launch"))?.addEventListener("click", async () => {
    try { await ShinsekaiAPI.openPath({ path: "data/chat_history" }); }
    catch (err) { notify(`打开历史目录失败：${err.message}`); }
  });

  document.addEventListener("input", (event) => {
    const target = event.target;
    if (!(target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement)) return;
    if (target.closest("#screen-sessions")) {
      if (target === findFieldControl("出场角色", $("#screen-sessions"))) {
        setSelectedSessionCharacters(selectedCharactersFromInput());
        markFreshSession("character");
        return;
      }
      if (target === findFieldControl("场景背景", $("#screen-sessions"))) {
        selectedBackgroundName = target.value;
        const bg = currentBackground();
        selectedBackgroundSpritePath = firstResourcePath(bg?.sprites);
        if (bg) hydrateBackgroundEditor(bg);
        markFreshSession("background");
        return;
      }
      refreshAllDerivedState();
    }
  });
}

function wireApiButtons() {
  const templateSelect = $("#screen-sessions aside .section-group select");
  templateSelect?.addEventListener("change", async () => {
    try { await loadTemplateIntoSession(templateSelect.value, { silent: false, replaceBlankOnly: false }); }
    catch (err) { notify(`加载模板失败：${err.message}`); }
  });

  findButton("保存配置", $("#screen-services"))?.addEventListener("click", async () => {
    try {
      const res = await ShinsekaiAPI.saveApiConfig(collectApiConfig());
      notify(res?.message || "API 配置已保存");
    } catch (err) {
      notify(`保存失败：${err.message}`);
    }
  });

  findButton("应用全部", $("#screen-services"))?.addEventListener("click", async () => {
    try {
      const res = await ShinsekaiAPI.saveApiConfig(collectApiConfig());
      notify(res?.message || "已保存并应用");
    } catch (err) {
      notify(`应用失败：${err.message}`);
    }
  });

  findButton("测试连接", $("#screen-services"))?.addEventListener("click", async () => {
    try {
      const res = await ShinsekaiAPI.testConnection(collectApiConfig());
      notify(res?.message || "连接测试完成");
    } catch (err) {
      notify(`连接测试失败：${err.message}`);
    }
  });

  findButton("保存人物", $("#screen-characters"))?.addEventListener("click", async () => {
    const payload = collectCharacterEditor();
    if (!payload.name) return notify("人物名称不能为空");
    try {
      const res = await ShinsekaiAPI.saveCharacter(payload.name, payload);
      await hydrateFromBackend();
      notify(res?.message || "人物已保存");
    } catch (err) {
      notify(`人物保存失败：${err.message}`);
    }
  });

  findButton("保存场景", $("#screen-scenes"))?.addEventListener("click", async () => {
    const payload = collectBackgroundEditor();
    if (!payload.name) return notify("场景名称不能为空");
    try {
      const res = await ShinsekaiAPI.saveBackground(payload.name, payload);
      await hydrateFromBackend();
      notify(res?.message || "场景已保存");
    } catch (err) {
      notify(`场景保存失败：${err.message}`);
    }
  });

  findButton("加载模板", $("#screen-sessions"))?.addEventListener("click", async () => {
    try { await loadSelectedTemplate(); }
    catch (err) { notify(`加载模板失败：${err.message}`); }
  });

  findButton("保存当前模板", $("#screen-sessions"))?.addEventListener("click", async () => {
    try { await saveCurrentTemplate(false); }
    catch (err) { notify(`保存模板失败：${err.message}`); }
  });

  findButton("复制模板", $("#screen-sessions"))?.addEventListener("click", async () => {
    try { await saveCurrentTemplate(true); }
    catch (err) { notify(`复制模板失败：${err.message}`); }
  });

  findButton("生成模板", $("#screen-sessions"))?.addEventListener("click", async () => {
    try {
      const payload = collectSessionBuilder();
      const res = await ShinsekaiAPI.generateTemplate(payload);
      setCurrentSystemTemplate(res?.system_template || "", sessionTemplateKey(payload));
      renderTemplatePreview({ ...payload, system_template: currentSystemTemplate });
      notify(res?.message || "模板已生成");
    } catch (err) {
      notify(`生成模板失败：${err.message}`);
    }
  });

  $$("button").filter((btn) => textOf(btn) === "启动演出").forEach((btn) => {
    btn.addEventListener("click", async () => {
      try {
        const session = collectSessionBuilder();
        const payload = {
          ...session,
          user_scenario: session.scenario,
          system_template: systemTemplateForLaunch(session),
          selected_bg: session.bg_name || firstBackground()?.name || "TRANSPARENT",
          room_id: ""
        };
        const res = await ShinsekaiAPI.launch(payload);
        await hydrateLaunchMonitor();
        notify(res?.message || "聊天进程已启动");
      } catch (err) {
        notify(`启动失败：${err.message}`);
      }
    });
  });

  findButton("继续上次聊天", $("#screen-launch"))?.addEventListener("click", async () => {
    try {
      const res = await ShinsekaiAPI.resumeLaunch();
      await hydrateLaunchMonitor();
      notify(res?.message || "已尝试继续上次聊天");
    } catch (err) {
      notify(`恢复失败：${err.message}`);
    }
  });

  findButton("清空历史并启动", $("#screen-launch"))?.addEventListener("click", async () => {
    try {
      setField("历史文件路径", "", $("#screen-sessions"));
      const session = collectSessionBuilder();
      const freshHistoryFile = buildFreshHistoryFilePath();
      const res = await ShinsekaiAPI.launch({
        ...session,
        user_scenario: session.scenario,
        system_template: systemTemplateForLaunch(session),
        history_file: freshHistoryFile,
        selected_bg: session.bg_name || firstBackground()?.name || "TRANSPARENT",
        room_id: ""
      });
      await hydrateLaunchMonitor();
      notify(res?.message || "聊天进程已启动");
    } catch (err) {
      notify(`启动失败：${err.message}`);
    }
  });

}

async function hydrateFromBackend() {
  try {
    const state = await ShinsekaiAPI.appState();
    backendState = state;
    hydrateRealProjectState(state);
    document.dispatchEvent(new CustomEvent("shinsekai:state", { detail: state }));
  } catch (err) {
    console.warn(`Shinsekai API 未连接：${getApiBase()}`, err);
  }
}

function boot() {
  ensureToggleInteractionStyle();
  installSessionStateGuards();
  wireOriginalNavigation();
  wireOriginalToolModal();
  wireTogglesAsStateOnly();
  wireSessionRuleRows();
  wireDetailedSettingsPanels();
  wireMiscStateButtons();
  wireApiButtons();
  hydrateFromBackend();
  window.setInterval(() => {
    const launchVisible = $("#screen-launch")?.classList.contains("active");
    if (launchVisible) hydrateLaunchMonitor();
  }, 2500);
}

boot();
