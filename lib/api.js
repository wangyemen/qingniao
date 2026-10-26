// API 调用层：OpenAI 兼容接口 + 多 Key 轮换
// 同一供应商可挂多个 Key，按顺序轮询；遇到 401/403/429 自动切换下一个 Key 重试。

import { enabledKeys } from "./storage.js";

export class ApiError extends Error {
  constructor(message, status, keyLabel) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.keyLabel = keyLabel;
  }
}

// 每个 provider 记录当前轮询到的 key 下标，实现多 Key 负载分散
const keyCursor = new Map();

export function pickKey(provider) {
  const keys = enabledKeys(provider);
  if (keys.length === 0) {
    throw new ApiError("该供应商没有可用的 API Key，请先在设置中添加。", 0, null);
  }
  const cursor = keyCursor.get(provider.id) || 0;
  const key = keys[cursor % keys.length];
  keyCursor.set(provider.id, (cursor + 1) % keys.length);
  return { key, keys };
}

// 清洗粘贴进来的 Key：去掉 Bearer 前缀、引号、所有空白符
export function sanitizeKey(raw) {
  return String(raw || "")
    .trim()
    .replace(/^["']|["']$/g, "")
    .replace(/^bearer\s+/i, "")
    .replace(/\s+/g, "");
}

// 合法的 HTTP 头名字（Chrome 对非法名字会直接抛错，所以要滤掉）
const HEADER_NAME_RE = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/;

// 拼请求头。
//
// 除了默认的 Bearer 鉴权，还支持**每个供应商自定义请求头** ——
// 像 Cloudflare AI Gateway（鉴权网关）要额外带 cf-aig-authorization，
// 有些自建网关还要 X-Api-Key / X-Tenant 之类。
// 规则：
//   · 自定义头里写了 Authorization → **以你的为准**（自动 Bearer 就不再叠加）
//   · 值里可以用 {{key}} / {{apiKey}} 占位符，会替换成当前轮询到的那个 API Key
//   · 名字不合法的直接跳过（否则 fetch 会抛错，整轮请求都发不出去）
export function buildHeaders(provider, key) {
  const compat = apiCompatOf(provider);
  const custom = (provider && Array.isArray(provider.headers) ? provider.headers : []).filter(
    (h) => h && HEADER_NAME_RE.test(String(h.name || "").trim())
  );
  const out = { "Content-Type": "application/json" };
  const has = (n) => custom.some((h) => new RegExp("^" + n + "$", "i").test(String(h.name).trim()));
  const keyValue = sanitizeKey(key && key.value);

  if (provider && provider.authMode !== "none") {
    if (compat === "anthropic") {
      if (!has("x-api-key")) out["x-api-key"] = keyValue;
      if (!has("anthropic-version")) out["anthropic-version"] = ANTHROPIC_VERSION;
    } else if (!has("authorization")) {
      out.Authorization = "Bearer " + keyValue;
    }
  } else if (compat === "anthropic" && !has("anthropic-version")) {
    // 就算选了"不加鉴权"，Anthropic 的版本头还是要带
    out["anthropic-version"] = ANTHROPIC_VERSION;
  }

  for (const h of custom) {
    const name = String(h.name).trim();
    const value = String(h.value == null ? "" : h.value).replace(/\{\{\s*(key|apiKey|api_key)\s*\}\}/gi, keyValue);
    out[name] = value;
  }
  return out;
}

// 只发 Bearer 的简版（域名探测用；那套是 Agnes/OpenAI 风格）
function authHeaders(key) {
  return {
    "Content-Type": "application/json",
    Authorization: "Bearer " + sanitizeKey(key.value),
  };
}

// ===== 兼容方式：OpenAI 兼容 / Anthropic 兼容（每个供应商二选一）=====
//
// OpenAI 兼容：POST {baseUrl}/chat/completions，Authorization: Bearer <key>
// Anthropic 兼容：POST {baseUrl}/messages，x-api-key: <key> + anthropic-version: 2023-06-01
// 两者的**消息格式、鉴权头、流事件都不一样**，所以下面分两套走。
export function apiCompatOf(provider) {
  return provider && provider.apiCompat === "anthropic" ? "anthropic" : "openai";
}

export const ANTHROPIC_VERSION = "2023-06-01";

// 把应用内部的 OpenAI 形状消息转成 Anthropic 的：
//   · system 要单独拎出来（Anthropic 不接受 messages 里的 system 角色）
//   · 图片块 image_url → { type:"image", source:… }（data URL 走 base64，http 走 url）
//   · **相邻同角色消息必须合并** —— Anthropic 要求 user/assistant 交替，否则直接报错
function toAnthropicMessages(messages) {
  const systemParts = [];
  const out = [];
  const textOf = (c) => (typeof c === "string" ? c : "");

  for (const m of messages || []) {
    const role = m && m.role;
    if (!role) continue;
    if (role === "system") {
      if (typeof m.content === "string" && m.content.trim()) systemParts.push(m.content);
      else if (Array.isArray(m.content)) for (const p of m.content) if (p && p.type === "text") systemParts.push(p.text || "");
      continue;
    }
    const r = role === "assistant" ? "assistant" : "user";

    // 内容块 → Anthropic 块
    let blocks;
    if (typeof m.content === "string") {
      blocks = [{ type: "text", text: m.content }];
    } else if (Array.isArray(m.content)) {
      blocks = [];
      for (const p of m.content || []) {
        if (!p) continue;
        if (p.type === "text") blocks.push({ type: "text", text: String(p.text || "") });
        else if (p.type === "image_url") {
          const url = String((p.image_url && p.image_url.url) || "");
          const data = /^data:([^;,]+);base64,(.+)$/s.exec(url);
          if (data) {
            blocks.push({ type: "image", source: { type: "base64", media_type: data[1], data: data[2] } });
          } else if (/^https?:\/\//i.test(url)) {
            blocks.push({ type: "image", source: { type: "url", url } });
          }
        }
      }
      if (!blocks.length) blocks = [{ type: "text", text: "" }];
    } else {
      blocks = [{ type: "text", text: textOf(m.content) }];
    }

    const prev = out[out.length - 1];
    if (prev && prev.role === r) {
      // 合并到上一条（Anthropic 不允许连续同角色）
      if (typeof prev.content === "string" && blocks.length === 1 && blocks[0].type === "text") {
        prev.content = prev.content + "\n\n" + blocks[0].text;
      } else {
        const prevBlocks = typeof prev.content === "string" ? [{ type: "text", text: prev.content }] : prev.content;
        prev.content = [...prevBlocks, ...blocks];
      }
    } else {
      // 单块纯文本就直接用字符串（更贴近官方示例，兼容性最好）
      out.push({ role: r, content: blocks.length === 1 && blocks[0].type === "text" ? blocks[0].text : blocks });
    }
  }
  return { system: systemParts.filter(Boolean).join("\n\n"), messages: out };
}

// Anthropic 请求的 URL / 头 / body
function anthropicRequest(provider, key, model, messages, { maxTokens, stream }) {
  const { system, messages: msgs } = toAnthropicMessages(messages);
  const body = {
    model,
    // Anthropic 的 max_tokens 是**必填**的
    max_tokens: Number(maxTokens) > 0 ? Math.round(Number(maxTokens)) : 4096,
    messages: msgs,
    stream: !!stream,
    temperature: 0.7,
  };
  if (system) body.system = system;
  return { url: endpoint(provider.baseUrl, "/messages"), headers: buildHeaders(provider, key), body };
}

function unauthorizedHint() {
  return (
    "（401 通常是 API Key 与接入域名不匹配：" +
    "国际站 key 用 apihub.agnes-ai.com，国内站 key 用 api.agnes-ai.cn，" +
    "兜底域名 apihub.agnes-ai.cn 兼容两种；" +
    "也可能是 Key 复制不完整、已过期，或误带了 Bearer 前缀。" +
    "可在设置里用「探测域名」自动匹配）"
  );
}

function endpoint(baseUrl, path) {
  return baseUrl.replace(/\/+$/, "") + path;
}

// 流式聊天。onDelta(text) 收到增量文本；onReasoning(text) 收到思考过程增量；返回完整文本。
// thinkingEnabled 时带 chat_template_kwargs.enable_thinking（Agnes/OpenAI 兼容深度思考参数）
export async function chatStream({ provider, model, messages, onDelta, onReasoning, signal, thinkingEnabled, maxTokens }) {
  const { key, keys } = pickKey(provider);
  let startIndex = keys.indexOf(key);
  let lastError = null;

  // 最多把所有 key 都试一遍
  for (let attempt = 0; attempt < keys.length; attempt++) {
    const current = keys[(startIndex + attempt) % keys.length];
    try {
      const text = await streamOnce(provider, current, model, messages, onDelta, onReasoning, signal, thinkingEnabled, maxTokens);
      return { text, keyLabel: current.label || current.id };
    } catch (err) {
      lastError = err;
      const retriable = err.status === 401 || err.status === 403 || err.status === 429;
      if (!retriable || attempt === keys.length - 1) {
        throw err;
      }
      // 提示切换 key（onDelta 里不打扰，仅在错误时抛出）
    }
  }
  throw lastError;
}

async function streamOnce(provider, key, model, messages, onDelta, onReasoning, signal, thinkingEnabled, maxTokens) {
  const compat = apiCompatOf(provider);

  let url;
  let headers;
  let body;
  if (compat === "anthropic") {
    const req = anthropicRequest(provider, key, model, messages, { maxTokens, stream: true });
    url = req.url;
    headers = req.headers;
    body = req.body;
  } else {
    body = {
      model,
      messages,
      stream: true,
      temperature: 0.7,
    };
    // 回复上限：每个模型可以有自己的值（在设置里逐模型配置），没配就不带这个字段
    if (Number(maxTokens) > 0) body.max_tokens = Math.round(Number(maxTokens));
    if (thinkingEnabled) {
      body.chat_template_kwargs = { enable_thinking: true };
    }
    url = endpoint(provider.baseUrl, "/chat/completions");
    headers = buildHeaders(provider, key);
  }

  const res = await fetch(url, {
    method: "POST",
    headers,
    signal,
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    let detail = "";
    try {
      detail = (await res.text()).slice(0, 300);
    } catch (_) {}
    const label = key.label || key.id;
    let msg = `请求失败 HTTP ${res.status}${detail ? "：" + detail : ""}`;
    if (res.status === 401) {
      msg +=
        compat === "anthropic"
          ? "（Anthropic 兼容接入：401 通常是 x-api-key 不对/缺失，或 Key 与接入域名不匹配）"
          : "\n" + unauthorizedHint();
    }
    throw new ApiError(msg, res.status, label);
  }

  if (!res.body) {
    throw new ApiError("响应无内容流", 0, key.label || key.id);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buffer = "";
  let full = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    const lines = buffer.split("\n");
    buffer = lines.pop() || "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || !trimmed.startsWith("data:")) continue;
      const payload = trimmed.slice(5).trim();
      if (payload === "[DONE]") continue;
      let json;
      try {
        json = JSON.parse(payload);
      } catch (_) {
        continue;
      }
      const delta = json?.choices?.[0]?.delta;
      if (delta?.reasoning_content) {
        if (onReasoning) onReasoning(delta.reasoning_content);
      }
      if (delta?.content) {
        full += delta.content;
        if (onDelta) onDelta(delta.content, full);
      }

      // —— Anthropic 兼容的流事件 ——
      // 形如 {"type":"content_block_delta","delta":{"type":"text_delta","text":"…"}}
      if (json?.type === "content_block_delta" && json.delta) {
        const d = json.delta;
        if (d.type === "thinking_delta" && d.thinking) {
          if (onReasoning) onReasoning(d.thinking);
        } else if (d.text) {
          full += d.text;
          if (onDelta) onDelta(d.text, full);
        }
      }
      // 有些兼容实现（或非流式回包）把整段塞在 message 里
      if (json?.type === "message" && Array.isArray(json.content)) {
        for (const b of json.content) {
          if (b && b.type === "text" && b.text) {
            full += b.text;
            if (onDelta) onDelta(b.text, full);
          }
        }
      }
    }
  }
  return full;
}

// 测试某个 key 是否可用（发一条极短的对话）
export async function testKey(provider, key, modelId) {
  const model = modelId || provider.models?.[0]?.id;
  if (!model) throw new ApiError("供应商未配置模型", 0, key.label || key.id);
  const compat = apiCompatOf(provider);

  let url;
  let headers;
  let payload;
  if (compat === "anthropic") {
    const req = anthropicRequest(provider, key, model, [{ role: "user", content: "hi" }], { maxTokens: 1, stream: false });
    url = req.url;
    headers = req.headers;
    payload = req.body;
  } else {
    url = endpoint(provider.baseUrl, "/chat/completions");
    headers = buildHeaders(provider, key);
    payload = { model, messages: [{ role: "user", content: "hi" }], max_tokens: 1 };
  }

  const res = await fetch(url, { method: "POST", headers, body: JSON.stringify(payload) });
  if (!res.ok) {
    let detail = "";
    try {
      detail = (await res.text()).slice(0, 200);
    } catch (_) {}
    let msg = `HTTP ${res.status}${detail ? "：" + detail : ""}`;
    if (res.status === 401) {
      msg +=
        compat === "anthropic"
          ? "（Anthropic 兼容接入：401 通常是 x-api-key 不对/缺失，或 Key 与接入域名不匹配）"
          : "\n" + unauthorizedHint();
    }
    throw new ApiError(msg, res.status, key.label || key.id);
  }
  return true;
}

// 候选接入域名：国际站 / 国内站 / 兜底（兼容两种 Key）
export const AGNES_DOMAINS = [
  "https://apihub.agnes-ai.com/v1",
  "https://apihub.agnes-ai.cn/v1",
  "https://api.agnes-ai.cn/v1",
];

// 用给定 key 依次探测候选域名，返回第一个通过 GET /models 的域名
export async function probeDomains(key, domains = AGNES_DOMAINS) {
  const results = [];
  for (const base of domains) {
    try {
      const res = await fetch(endpoint(base, "/models"), {
        headers: { Authorization: "Bearer " + sanitizeKey(key.value) },
      });
      results.push({ base, ok: res.ok, status: res.status });
      if (res.ok) return { matched: base, results };
    } catch (err) {
      results.push({ base, ok: false, status: 0, error: String(err.message || err) });
    }
  }
  return { matched: null, results };
}
