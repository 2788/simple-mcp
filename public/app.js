const statusEl = document.querySelector("#status");
const connectForm = document.querySelector("#connect-form");
const connectButton = document.querySelector("#connect");
const disconnectButton = document.querySelector("#disconnect");
const refreshButton = document.querySelector("#refresh-tools");
const toolsEl = document.querySelector("#tools");
const resultEl = document.querySelector("#result");
const logEl = document.querySelector("#log");
const messageUrlEl = document.querySelector("#message-url");
const serverInfoEl = document.querySelector("#server-info");
const transportSelect = document.querySelector("#transport");
const endpointEl = document.querySelector("#sse-url");

const transportHints = {
  sse: ["HTTP + SSE", "GET /mcp", "等待 endpoint 事件"],
  streamable: ["Streamable HTTP", "POST /mcp", "初始化后获得 Mcp-Session-Id"],
};

const state = {
  mode: "sse",
  abort: null,
  endpoint: "",
  sessionId: "",
  protocolVersion: "",
  pending: new Map(),
  nextId: 0,
  ready: false,
};

connectForm.addEventListener("submit", (event) => {
  event.preventDefault();
  void connect();
});

disconnectButton.addEventListener("click", () => disconnect("已断开"));
refreshButton.addEventListener("click", () => void refreshTools());
transportSelect.addEventListener("change", syncTransportHint);
document.querySelector("#clear-log").addEventListener("click", () => {
  logEl.replaceChildren();
});
syncTransportHint();

function setStatus(text, mode) {
  statusEl.textContent = text;
  statusEl.dataset.state = mode;
}

function linxHeaders() {
  return {
    "X-Linx-Device-Id": document.querySelector("#device-id").value.trim(),
    "X-Linx-Agent-Id": document.querySelector("#agent-id").value.trim(),
    "X-Linx-Session-Id": document.querySelector("#session-id").value.trim(),
  };
}

function log(direction, title, payload) {
  const item = document.createElement("li");
  const time = document.createElement("time");
  time.textContent = new Date().toLocaleTimeString("zh-CN", { hour12: false });
  const dir = document.createElement("span");
  dir.className = "dir";
  dir.dataset.dir = direction;
  dir.textContent = direction === "out" ? "→" : "←";
  const name = document.createElement("strong");
  name.textContent = title;
  const pre = document.createElement("pre");
  pre.textContent =
    typeof payload === "string" ? payload : JSON.stringify(payload, null, 2);
  item.append(time, dir, name, pre);
  logEl.append(item);
  logEl.scrollTop = logEl.scrollHeight;
}

function syncTransportHint() {
  const [label, endpoint, message] = transportHints[transportSelect.value];
  document.querySelector("#endpoint-label").textContent = label;
  endpointEl.textContent = endpoint;
  if (!state.ready) messageUrlEl.textContent = message;
}

async function connect() {
  const mode = transportSelect.value;
  disconnect("连接中", { silent: true });
  state.mode = mode;
  transportSelect.disabled = true;
  setStatus("连接中", "busy");
  connectButton.disabled = true;
  if (mode === "streamable") {
    state.endpoint = "/mcp";
    messageUrlEl.textContent = "POST /mcp";
    await handshake("2025-03-26");
    return;
  }
  await connectSse();
}

async function connectSse() {
  const abort = new AbortController();
  state.abort = abort;

  let response;
  try {
    response = await fetch("/mcp", {
      headers: { Accept: "text/event-stream", ...linxHeaders() },
      signal: abort.signal,
    });
  } catch (error) {
    if (abort.signal.aborted) return;
    fail(`连接失败：${error.message}`);
    return;
  }

  if (!response.ok || !response.body) {
    fail(`连接失败：HTTP ${response.status}`);
    return;
  }

  const endpointTimer = setTimeout(() => {
    if (!state.endpoint && state.abort === abort) {
      fail("没有收到 endpoint 事件");
    }
  }, 8000);
  abort.signal.addEventListener("abort", () => clearTimeout(endpointTimer));
  void readStream(response.body, abort).finally(() => clearTimeout(endpointTimer));
}

async function readStream(body, abort) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let splitAt;
      while ((splitAt = buffer.indexOf("\n\n")) !== -1) {
        const raw = buffer.slice(0, splitAt);
        buffer = buffer.slice(splitAt + 2);
        const parsed = parseEvent(raw);
        if (parsed) handleEvent(parsed);
      }
    }
    if (!abort.signal.aborted) disconnect("连接已关闭");
  } catch (error) {
    if (!abort.signal.aborted) fail(`连接中断：${error.message}`);
  }
}

function parseEvent(raw) {
  if (!raw.trim()) return null;
  let event = "message";
  const data = [];
  for (const line of raw.split("\n")) {
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
  }
  return { event, data: data.join("\n").trim() };
}

function handleEvent(parsed) {
  if (parsed.event === "endpoint") {
    state.endpoint = parsed.data;
    messageUrlEl.textContent = `POST ${parsed.data}`;
    log("in", "endpoint", parsed.data);
    void handshake();
    return;
  }

  if (parsed.event !== "message" || !parsed.data) return;

  let message;
  try {
    message = JSON.parse(parsed.data);
  } catch {
    log("in", "无法解析的消息", parsed.data);
    return;
  }
  deliver(message);
}

function deliver(message) {
  const title = message.id == null ? "notification" : `id ${message.id}`;
  log("in", title, message);
  const waiter = state.pending.get(message.id);
  if (!waiter) return;
  state.pending.delete(message.id);
  clearTimeout(waiter.timer);
  if (message.error) waiter.reject(new Error(message.error.message || "MCP 错误"));
  else waiter.resolve(message.result);
}

async function handshake(protocolVersion = "2024-11-05") {
  state.protocolVersion = protocolVersion;
  try {
    const result = await rpc("initialize", {
      protocolVersion,
      capabilities: {},
      clientInfo: { name: "simple-mcp-ui", version: "1.0.0" },
    });
    state.protocolVersion = result.protocolVersion || protocolVersion;
    const info = result.serverInfo || {};
    serverInfoEl.textContent = `${info.name || "unknown"} ${info.version || ""} · ${state.protocolVersion}`.trim();
    await notify("notifications/initialized");
    state.ready = true;
    disconnectButton.disabled = false;
    refreshButton.disabled = false;
    setStatus("已连接", "ready");
    await refreshTools();
  } catch (error) {
    fail(`初始化失败：${error.message}`);
  }
}

async function refreshTools() {
  refreshButton.disabled = true;
  setStatus("获取工具", "busy");
  try {
    const result = await rpc("tools/list");
    renderTools(result.tools || []);
    setStatus("已连接", "ready");
  } catch (error) {
    toolsEl.replaceChildren(paragraph(`获取工具失败：${error.message}`));
    setStatus("已连接", "error");
  } finally {
    refreshButton.disabled = !state.ready;
  }
}

async function callTool(name, args) {
  setStatus("调用中", "busy");
  try {
    const result = await rpc("tools/call", { name, arguments: args });
    renderResult(result);
    setStatus(result.isError ? "调用失败" : "已连接", result.isError ? "error" : "ready");
  } catch (error) {
    renderResult({
      isError: true,
      content: [{ type: "text", text: error.message }],
    });
    setStatus("调用失败", "error");
  }
}

function rpc(method, params) {
  const id = ++state.nextId;
  const body = { jsonrpc: "2.0", id, method };
  if (params !== undefined) body.params = params;
  log("out", method, body);
  const result = waitFor(id);
  void post(body).catch((error) => {
    const waiter = state.pending.get(id);
    if (!waiter) return;
    state.pending.delete(id);
    clearTimeout(waiter.timer);
    waiter.reject(error);
  });
  return result;
}

function notify(method) {
  const body = { jsonrpc: "2.0", method };
  log("out", method, body);
  return post(body);
}

function waitFor(id) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      state.pending.delete(id);
      reject(new Error("等待响应超时"));
    }, 15000);
    state.pending.set(id, { resolve, reject, timer });
  });
}

async function post(body) {
  if (state.mode === "streamable") {
    await postStreamable(body);
    return;
  }
  if (!state.endpoint) throw new Error("还没有消息地址");
  const response = await fetch(state.endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...linxHeaders() },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    throw new Error(`POST ${response.status} ${await response.text()}`);
  }
}

async function postStreamable(body) {
  const headers = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
    ...linxHeaders(),
  };
  if (state.sessionId) headers["mcp-session-id"] = state.sessionId;
  if (state.protocolVersion && body.method !== "initialize") {
    headers["mcp-protocol-version"] = state.protocolVersion;
  }

  const response = await fetch("/mcp", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  const sessionId = response.headers.get("mcp-session-id");
  if (sessionId) {
    state.sessionId = sessionId;
    messageUrlEl.textContent = `POST /mcp · ${sessionId}`;
  }
  if (!response.ok) {
    throw new Error(`POST ${response.status} ${await response.text()}`);
  }
  if (response.status === 202) {
    await response.body?.cancel();
    return;
  }

  const contentType = response.headers.get("content-type") || "";
  if (contentType.includes("text/event-stream")) {
    await consumeSse(response);
    return;
  }
  if (contentType.includes("application/json")) {
    deliver(await response.json());
  }
}

async function consumeSse(response) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let splitAt;
    while ((splitAt = buffer.indexOf("\n\n")) !== -1) {
      const raw = buffer.slice(0, splitAt);
      buffer = buffer.slice(splitAt + 2);
      const parsed = parseEvent(raw);
      if (!parsed?.data) continue;
      try {
        deliver(JSON.parse(parsed.data));
      } catch {
        log("in", "无法解析的消息", parsed.data);
      }
    }
  }
}

function renderTools(tools) {
  toolsEl.replaceChildren();
  if (!tools.length) {
    toolsEl.append(paragraph("tools/list 没有返回工具。"));
    return;
  }

  for (const tool of tools) {
    const card = document.createElement("article");
    card.className = "tool-card";
    const heading = document.createElement("h3");
    heading.textContent = tool.name;
    card.append(heading);
    if (tool.title) {
      const title = document.createElement("p");
      title.className = "tool-title";
      title.textContent = tool.title;
      card.append(title);
    }
    if (tool.description) {
      const description = document.createElement("p");
      description.textContent = tool.description;
      card.append(description);
    }

    const form = document.createElement("form");
    form.className = "tool-form";
    const fields = schemaFields(tool.inputSchema);
    if (!fields.length) {
      const hint = document.createElement("p");
      hint.className = "hint";
      hint.textContent = "这个工具没有参数，会播放固定歌曲「夜上海」。";
      form.append(hint);
    }

    for (const field of fields) {
      const label = document.createElement("label");
      label.append(`${field.name}${field.required ? "（必填）" : "（可选）"}`);
      const input = document.createElement("input");
      input.name = field.name;
      input.placeholder = field.description || field.type;
      label.append(input);
      if (field.description) {
        const hint = document.createElement("span");
        hint.className = "hint";
        hint.textContent = field.description;
        label.append(hint);
      }
      form.append(label);
    }

    const actions = document.createElement("div");
    actions.className = "tool-actions";
    const submit = document.createElement("button");
    submit.type = "submit";
    submit.textContent = "调用 tools/call";
    actions.append(submit);
    form.append(actions);
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      const args = {};
      for (const field of fields) {
        const value = new FormData(form).get(field.name);
        const text = typeof value === "string" ? value.trim() : "";
        if (text) args[field.name] = text;
      }
      void callTool(tool.name, args);
    });
    card.append(form);
    toolsEl.append(card);
  }
}

function schemaFields(schema) {
  const properties = schema?.properties || {};
  const required = new Set(schema?.required || []);
  return Object.entries(properties).map(([name, property]) => ({
    name,
    required: required.has(name),
    description: property.description || "",
    type: property.type || "string",
  }));
}

function renderResult(result) {
  resultEl.replaceChildren();
  const banner = document.createElement("p");
  banner.className = result.isError ? "result-error" : "hint";
  banner.textContent = result.isError ? "工具返回 isError: true" : "工具返回 isError: false";
  resultEl.append(banner);

  const funcs = result.structuredContent?.funcs;
  if (Array.isArray(funcs) && funcs.length) {
    const list = document.createElement("div");
    list.className = "funcs";
    for (const func of funcs) {
      const block = document.createElement("div");
      block.className = "func";
      const name = document.createElement("strong");
      name.textContent = func.name || "系统调用";
      block.append(name);
      const args = func.arguments || {};
      for (const [key, value] of Object.entries(args)) {
        const line = document.createElement("div");
        if (key === "audio_url" && typeof value === "string") {
          line.textContent = `${key}：`;
          const link = document.createElement("a");
          link.href = value;
          link.target = "_blank";
          link.rel = "noreferrer";
          link.textContent = value;
          line.append(link);
          const audio = document.createElement("audio");
          audio.controls = true;
          audio.src = value;
          block.append(line, audio);
          continue;
        }
        line.textContent = `${key}：${value}`;
        block.append(line);
      }
      list.append(block);
    }
    resultEl.append(list);
  }

  const contentText = (result.content || [])
    .filter((item) => item.type === "text")
    .map((item) => item.text)
    .join("\n");
  if (contentText) {
    const pre = document.createElement("pre");
    pre.textContent = contentText;
    resultEl.append(pre);
  }
}

function disconnect(label, options = {}) {
  const sessionId = state.sessionId;
  const mode = state.mode;
  const protocolVersion = state.protocolVersion;
  state.abort?.abort();
  state.abort = null;
  state.endpoint = "";
  state.sessionId = "";
  state.protocolVersion = "";
  state.ready = false;
  for (const waiter of state.pending.values()) {
    clearTimeout(waiter.timer);
    waiter.reject(new Error("连接已断开"));
  }
  state.pending.clear();
  transportSelect.disabled = false;
  syncTransportHint();
  serverInfoEl.textContent = "尚未 initialize";
  refreshButton.disabled = true;
  disconnectButton.disabled = true;
  connectButton.disabled = false;
  if (mode === "streamable" && sessionId) {
    fetch("/mcp", {
      method: "DELETE",
      headers: {
        "mcp-session-id": sessionId,
        "mcp-protocol-version": protocolVersion,
        ...linxHeaders(),
      },
    }).catch(() => {});
  }
  toolsEl.replaceChildren(paragraph("连接后会自动发送 tools/list。"));
  if (!options.silent) setStatus(label, label === "已断开" ? "idle" : "error");
}

function fail(message) {
  log("in", "error", message);
  disconnect(message);
  setStatus(message, "error");
}

function paragraph(text) {
  const node = document.createElement("p");
  node.className = "empty";
  node.textContent = text;
  return node;
}
