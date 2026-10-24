// 存储层：供应商 / 模型 / API Key 管理
// 数据结构:
// {
//   providers: [
//     {
//       id: "agnes",
//       name: "Agnes AI",
//       baseUrl: "https://apihub.agnes-ai.com/v1",
//       models: [{ id: "agnes-2.5-flash", label: "Agnes 2.5 Flash" }],
//       keys: [{ id: "k1", label: "主 key", value: "sk-...", enabled: true }]
//     }
//   ],
//   activeProviderId: "agnes",
//   activeModelId: "agnes-2.5-flash",
//   contextEnabled: true
// }

const STORAGE_KEY = "ai_browser_settings";

export const DEFAULT_SETTINGS = {
  providers: [
    {
      id: "agnes",
      name: "Agnes AI",
      baseUrl: "https://apihub.agnes-ai.com/v1",
      models: [
        { id: "agnes-2.5-flash", label: "Agnes 2.5 Flash", vision: true },
        { id: "agnes-2.0-flash", label: "Agnes 2.0 Flash", vision: true },
      ],
      keys: [],
    },
  ],
  activeProviderId: "agnes",
  activeModelId: "agnes-2.5-flash",
  contextEnabled: true,
  thinkingEnabled: true,
  controlEnabled: true,
  autoExecute: false,
  // 记忆压缩：上下文用到这个比例就自动把历史压成摘要（用户要求 90%）
  contextWindow: 128000,
  autoCompressAt: 0.9,
  // 回复上限（单次最多生成多少 token）。**每个模型可以有自己的值**（providers[].models[].maxTokens），
  // 这里只是"模型没配时"的兜底。
  maxTokens: 4096,
  // AI 报错自动重试：第 1 次等 5 秒，之后每次 +1 秒；同一模型最多 5 次，
  // 仍失败就自动换下一个模型（用户要求）
  retryWaitSec: 5,
  retryMax: 5,
};

// 迁移旧配置：补上 vision / thinkingEnabled / control 字段（0.1.x 早期版本存的配置没有这些字段，
// 导致"附截图"开关被误判为不支持而禁用）
function migrate(settings) {
  for (const p of settings.providers || []) {
    for (const m of p.models || []) {
      if (m.vision === undefined) m.vision = true;
      // 每个模型可以有独立上限；非法值一律清成 null（= 用全局默认）
      if (!(m.contextWindow > 0)) m.contextWindow = null;
      if (!(m.maxTokens > 0)) m.maxTokens = null;
    }
  }
  if (settings.thinkingEnabled === undefined) settings.thinkingEnabled = true;
  if (settings.controlEnabled === undefined) settings.controlEnabled = true;
  if (settings.autoExecute === undefined) settings.autoExecute = false;
  if (!(settings.contextWindow > 0)) settings.contextWindow = 128000;
  if (!(settings.autoCompressAt > 0 && settings.autoCompressAt < 1)) settings.autoCompressAt = 0.9;
  if (!(settings.maxTokens > 0)) settings.maxTokens = 4096;
  if (!(settings.retryWaitSec >= 0)) settings.retryWaitSec = 5;
  if (!(settings.retryMax > 0)) settings.retryMax = 5;
  return settings;
}

// 这个模型实际生效的上限：模型自己的优先（providers[].models[].contextWindow / maxTokens），
// 否则用全局默认。定义在 findModel 之前也没关系（函数声明会提升）。
export function limitsFor(settings, provider, modelId) {
  const m = findModel(provider, modelId);
  const ctx = Number(m && m.contextWindow) > 0 ? Number(m.contextWindow) : Number(settings.contextWindow) || 128000;
  const out = Number(m && m.maxTokens) > 0 ? Number(m.maxTokens) : Number(settings.maxTokens) || 4096;
  return { contextWindow: ctx, maxTokens: out };
}

export async function getSettings() {
  const stored = await chrome.storage.local.get(STORAGE_KEY);
  const s = stored[STORAGE_KEY];
  if (!s || !Array.isArray(s.providers) || s.providers.length === 0) {
    return structuredClone(DEFAULT_SETTINGS);
  }
  return migrate(s);
}

export async function saveSettings(settings) {
  await chrome.storage.local.set({ [STORAGE_KEY]: settings });
}

export function findProvider(settings, providerId) {
  return settings.providers.find((p) => p.id === providerId) || null;
}

export function findModel(provider, modelId) {
  return (provider?.models || []).find((m) => m.id === modelId) || null;
}

export function enabledKeys(provider) {
  return (provider?.keys || []).filter((k) => k.enabled && k.value && k.value.trim());
}

export function maskKey(value) {
  if (!value) return "";
  const v = value.trim();
  if (v.length <= 8) return "****";
  return v.slice(0, 4) + "..." + v.slice(-4);
}

export function uid() {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
}

// ===== 会话历史 =====
// { id, title, createdAt, updatedAt, workspaceId, messages: [{role, content}] }

const SESSIONS_KEY = "ai_browser_sessions";
const MAX_SESSIONS = 200;

export async function listSessions() {
  const stored = await chrome.storage.local.get(SESSIONS_KEY);
  const list = stored[SESSIONS_KEY] || [];
  return list.sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function saveSession(session) {
  const list = await listSessions();
  session.updatedAt = Date.now();
  const idx = list.findIndex((s) => s.id === session.id);
  if (idx >= 0) list[idx] = session;
  else list.push(session);
  list.sort((a, b) => b.updatedAt - a.updatedAt);
  // 裁掉旧会话防止 storage 膨胀，但**绝不能裁掉"仍被某个工作区引用"的会话**：
  // 那会让后台任务续跑时找不到原会话，被迫开一个新会话 ——
  // 用户看到的就是"回复跑到别的会话里去了"（用户报告：会话之间的回复不能串）。
  const pinned = await referencedSessionIds();
  const out = [];
  for (const s of list) {
    if (out.length < MAX_SESSIONS || pinned.has(s.id)) out.push(s);
  }
  await chrome.storage.local.set({ [SESSIONS_KEY]: out });
}

const WORKSPACES_PREFIX = "ai_workspaces_";

// 当前所有窗口的工作区正在引用的会话 id（这些必须永远保留）
async function referencedSessionIds() {
  const ids = new Set();
  try {
    const all = await chrome.storage.local.get(null);
    for (const k of Object.keys(all)) {
      if (!k.startsWith(WORKSPACES_PREFIX)) continue;
      const list = all[k] && all[k].list;
      if (!Array.isArray(list)) continue;
      for (const w of list) {
        if (w && w.sessionId) ids.add(w.sessionId);
      }
    }
  } catch (_) {}
  return ids;
}

export async function deleteSession(id) {
  const list = await listSessions();
  await chrome.storage.local.set({
    [SESSIONS_KEY]: list.filter((s) => s.id !== id),
  });
}

// 删掉某个工作区名下的所有会话（工作区消失时用：用户明确要求"会话也自动删除"）
export async function deleteSessionsOfWorkspace(workspaceId) {
  if (!workspaceId) return;
  const list = await listSessions();
  await chrome.storage.local.set({
    [SESSIONS_KEY]: list.filter((s) => s.workspaceId !== workspaceId),
  });
}

export function newSession(workspaceId) {
  return {
    id: uid(),
    title: "新对话",
    createdAt: Date.now(),
    updatedAt: Date.now(),
    workspaceId: workspaceId || null,
    messages: [],
  };
}

// ===== 工作区（多工作区并存）=====
// 一个工作区 = 一组 AI 正在控制的标签页，彼此隔离（互相看不到、不能互相操作）。
// 存法：按窗口一份注册表 { list: [ {id, rootTabId, tabIds, sessionId, providerId, modelId, createdAt} ] }
// 用 chrome.storage.local（service worker 也要读，用于面板与清理）。

export const WORKSPACES_KEY = (windowId) => `ai_workspaces_${windowId == null ? "cur" : windowId}`;

export async function loadWorkspaces(windowId) {
  const key = WORKSPACES_KEY(windowId);
  const got = await chrome.storage.local.get(key);
  const raw = got[key];
  if (!raw || !Array.isArray(raw.list)) return { list: [] };
  // 清洗：丢掉结构不完整的记录
  const list = raw.list.filter((w) => w && w.id && Array.isArray(w.tabIds) && w.tabIds.length > 0);
  return { list };
}

export async function saveWorkspaces(windowId, list) {
  const key = WORKSPACES_KEY(windowId);
  if (!list || !list.length) {
    await chrome.storage.local.remove(key);
    return;
  }
  await chrome.storage.local.set({ [key]: { list } });
}

export function newWorkspace(rootTabId, providerId, modelId) {
  return {
    id: "ws_" + uid(),
    rootTabId,
    tabIds: [rootTabId],
    sessionId: null, // 第一次发消息时创建会话
    providerId: providerId || null,
    modelId: modelId || null,
    createdAt: Date.now(),
  };
}

// ===== 技能（技能市场 + 本地技能）=====
// 存法：一份对象表 { [id]: skill }，skill 里带 enabled / source / installedAt / marketUrl。
// 技能体积很小（一份 Markdown），直接放 storage.local 即可，也便于跨页面即时同步。

const SKILLS_KEY = "ai_skills";
const MARKET_KEY = "ai_market";

export async function loadSkills() {
  const got = await chrome.storage.local.get(SKILLS_KEY);
  const raw = got[SKILLS_KEY];
  if (!raw || typeof raw !== "object") return {};
  const out = {};
  for (const [id, s] of Object.entries(raw)) {
    if (!s || !s.id) continue;
    out[id] = {
      ...s,
      enabled: s.enabled !== false, // 默认启用
      source: s.source || "local",
      tags: Array.isArray(s.tags) ? s.tags : [],
    };
  }
  return out;
}

export async function saveSkills(map) {
  const clean = {};
  for (const [id, s] of Object.entries(map || {})) {
    if (!s || !s.id) continue;
    clean[id] = s;
  }
  if (!Object.keys(clean).length) {
    await chrome.storage.local.remove(SKILLS_KEY);
    return;
  }
  await chrome.storage.local.set({ [SKILLS_KEY]: clean });
}

export async function getSkill(id) {
  if (!id) return null;
  const all = await loadSkills();
  return all[id] || null;
}

export async function upsertSkill(skill) {
  if (!skill || !skill.id) throw new Error("技能缺少 id");
  const all = await loadSkills();
  const prev = all[skill.id] || {};
  all[skill.id] = {
    ...prev,
    ...skill,
    enabled: skill.enabled === undefined ? prev.enabled !== false : skill.enabled !== false,
    installedAt: prev.installedAt || Date.now(),
    updatedAt: Date.now(),
  };
  await saveSkills(all);
  return all[skill.id];
}

export async function deleteSkill(id) {
  const all = await loadSkills();
  delete all[id];
  await saveSkills(all);
}

export async function setSkillEnabled(id, on) {
  const all = await loadSkills();
  if (!all[id]) return null;
  all[id].enabled = !!on;
  await saveSkills(all);
  return all[id];
}

// 市场来源设置：{ source, repo, lastSyncAt, lastCount, lastError }
export async function loadMarketSettings() {
  const got = await chrome.storage.local.get(MARKET_KEY);
  return got[MARKET_KEY] || {};
}

export async function saveMarketSettings(patch) {
  const cur = await loadMarketSettings();
  const next = { ...cur, ...(patch || {}) };
  await chrome.storage.local.set({ [MARKET_KEY]: next });
  return next;
}

