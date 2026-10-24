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
    }
  }
  if (settings.thinkingEnabled === undefined) settings.thinkingEnabled = true;
  if (settings.controlEnabled === undefined) settings.controlEnabled = true;
  if (settings.autoExecute === undefined) settings.autoExecute = false;
  if (!(settings.contextWindow > 0)) settings.contextWindow = 128000;
  if (!(settings.autoCompressAt > 0 && settings.autoCompressAt < 1)) settings.autoCompressAt = 0.9;
  if (!(settings.retryWaitSec >= 0)) settings.retryWaitSec = 5;
  if (!(settings.retryMax > 0)) settings.retryMax = 5;
  return settings;
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

