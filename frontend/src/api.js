const DEFAULT_API_BASE = "http://127.0.0.1:8765";

export function getApiBase() {
  const fromWindow = window.SHINSEKAI_API_BASE;
  const fromStorage = window.localStorage.getItem("SHINSEKAI_API_BASE");
  const sameOrigin = window.location.protocol.startsWith("http")
    ? window.location.origin
    : DEFAULT_API_BASE;
  return (fromWindow || fromStorage || sameOrigin).replace(/\/$/, "");
}

async function request(path, options = {}) {
  const url = `${getApiBase()}${path}`;
  const headers = {
    "Accept": "application/json",
    ...(options.body ? { "Content-Type": "application/json" } : {}),
    ...(options.headers || {})
  };

  const res = await fetch(url, {
    ...options,
    headers,
    body: options.body && typeof options.body !== "string"
      ? JSON.stringify(options.body)
      : options.body
  });

  let data = null;
  const text = await res.text();
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = { raw: text };
    }
  }

  if (!res.ok) {
    const detail = data?.detail || data?.error || res.statusText || "请求失败";
    throw new Error(detail);
  }

  return data;
}

export const ShinsekaiAPI = {
  health: () => request("/api/health"),
  appState: () => request("/api/app-state"),

  getApiConfig: () => request("/api/config/api"),
  listLlmProviders: () => request("/api/llm/providers"),
  saveApiConfig: (payload) => request("/api/config/api", {
    method: "PUT",
    body: payload
  }),
  getSystemConfig: () => request("/api/config/system"),
  saveSystemConfig: (payload) => request("/api/config/system", {
    method: "PUT",
    body: payload
  }),
  saveAdapterExtra: (payload) => request("/api/config/adapter-extra", {
    method: "PUT",
    body: payload
  }),

  testConnection: (payload) => request("/api/services/test", {
    method: "POST",
    body: payload
  }),

  listCharacters: () => request("/api/characters"),
  saveCharacter: (name, payload) => request(`/api/characters/${encodeURIComponent(name)}`, {
    method: "PUT",
    body: payload
  }),
  deleteCharacter: (name) => request(`/api/characters/${encodeURIComponent(name)}`, {
    method: "DELETE"
  }),

  listBackgrounds: () => request("/api/backgrounds"),
  saveBackground: (name, payload) => request(`/api/backgrounds/${encodeURIComponent(name)}`, {
    method: "PUT",
    body: payload
  }),
  deleteBackground: (name) => request(`/api/backgrounds/${encodeURIComponent(name)}`, {
    method: "DELETE"
  }),

  listTemplates: () => request("/api/templates"),
  listHistories: () => request("/api/histories"),
  loadTemplate: (name) => request(`/api/templates/${encodeURIComponent(name)}`),
  saveTemplate: (payload) => request("/api/templates", {
    method: "POST",
    body: payload
  }),
  generateTemplate: (payload) => request("/api/templates/generate", {
    method: "POST",
    body: payload
  }),

  listPlugins: () => request("/api/plugins"),
  getPluginWebDetail: (entry) => request(`/api/plugins/web-detail?entry=${encodeURIComponent(entry || "")}`),
  savePluginWebFile: (payload) => request("/api/plugins/web-file", {
    method: "PUT",
    body: payload
  }),
  togglePlugin: (entry, enabled) => request("/api/plugins/toggle", {
    method: "POST",
    body: { entry, enabled }
  }),
  openPluginSettings: (entry) => request("/api/plugins/open-settings", {
    method: "POST",
    body: { entry }
  }),
  openPluginManifest: () => request("/api/plugins/open-manifest", {
    method: "POST",
    body: {}
  }),
  savePluginManifestRow: (payload) => request("/api/plugins/manifest-row", {
    method: "PUT",
    body: payload
  }),
  deletePluginManifestRow: (entry) => request(`/api/plugins/manifest-row/${encodeURIComponent(entry)}`, {
    method: "DELETE"
  }),

  getMcpConfig: () => request("/api/mcp"),
  saveMcpConfig: (payload) => request("/api/mcp", {
    method: "PUT",
    body: payload
  }),
  addMcpServer: (payload) => request("/api/mcp/servers", {
    method: "POST",
    body: payload
  }),
  updateMcpServer: (index, payload) => request(`/api/mcp/servers/${encodeURIComponent(index)}`, {
    method: "PUT",
    body: payload
  }),
  deleteMcpServer: (index) => request(`/api/mcp/servers/${encodeURIComponent(index)}`, {
    method: "DELETE"
  }),
  toggleMcpGlobal: (enabled) => request("/api/mcp/global/toggle", {
    method: "POST",
    body: { enabled }
  }),
  toggleMcpServer: (index, enabled) => request("/api/mcp/servers/toggle", {
    method: "POST",
    body: { index, enabled }
  }),
  listMcpTools: () => request("/api/mcp/tools"),
  openMcpConfig: () => request("/api/mcp/open-config", {
    method: "POST",
    body: {}
  }),

  refreshMcpTools: (payload = {}) => request("/api/mcp/tools/refresh", {
    method: "POST",
    body: payload
  }),

  launch: (payload) => request("/api/launch", {
    method: "POST",
    body: payload
  }),
  resumeLaunch: () => request("/api/launch/resume", {
    method: "POST",
    body: {}
  }),
  launchStatus: () => request("/api/launch/status"),
  stopLaunch: () => request("/api/launch/stop", {
    method: "POST",
    body: {}
  }),

  openPath: (payload) => request("/api/open-path", {
    method: "POST",
    body: payload
  }),
  runTool: (tool, payload) => request(`/api/tools/${encodeURIComponent(tool)}`, {
    method: "POST",
    body: payload
  })
};
