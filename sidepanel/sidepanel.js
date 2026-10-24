// 侧边栏调度层：管理"多个 AI 工作区"并让它们各自独立运行。
//
// 核心模型（用户明确要求）：
//   ① 一个工作区 = 一组 AI 正在控制的标签页。多个工作区可同时存在、同时跑任务、互不干扰。
//   ② 用户在某个标签页第一次发消息 → 为该页建一个工作区（懒创建，不预先铺一堆空工作区）。
//   ③ AI 在工作区里自己打开的新标签页 → 自动并入该工作区。
//   ④ 用户切到不属于任何工作区的标签页 → 侧栏切到"这个页面的空对话"，
//      首次发消息时再建工作区；不再有"这里不能用 AI"的死角。
//   ⑤ 工作区之间硬隔离：A 区看不到、读不到、也操作不了 B 区的标签页。
//   ⑥ 每个工作区可以有自己的模型，且支持中途切换。
//   ⑦ 工作区内的标签页全关 → 该工作区消失，其会话一并删除。
//
// Chrome 一个窗口只有一个侧栏文档实例，所以"独立"的做法是：
//   每个工作区一个 WorkspaceRuntime（自己的 chat DOM + 会话 + abort + busy），
//   非激活工作区的 chat DOM 脱离文档但**仍在运行**；切标签页只是把 DOM 换上去。

import {
  getSettings,
  saveSettings,
  findProvider,
  listSessions,
  saveSession,
  deleteSession,
  deleteSessionsOfWorkspace,
  newSession,
  loadWorkspaces,
  saveWorkspaces,
  newWorkspace,
} from "../lib/storage.js";
import { processFile, imagesFromClipboard } from "../lib/attach.js";
import { WorkspaceRuntime, noteOpenedTab } from "./workspace.js";

const chatHost = document.getElementById("chatHost");
const inputEl = document.getElementById("input");
const sendBtn = document.getElementById("sendBtn");
const newChatBtn = document.getElementById("newChatBtn");
const settingsBtn = document.getElementById("settingsBtn");
const historyBtn = document.getElementById("historyBtn");
const historyPanel = document.getElementById("historyPanel");
const historyListEl = document.getElementById("historyList");
const historyCloseBtn = document.getElementById("historyCloseBtn");
const modelSelect = document.getElementById("modelSelect");
const ctxToggle = document.getElementById("ctxToggle");
const ctlToggle = document.getElementById("ctlToggle");
const ctlWrap = document.getElementById("ctlWrap");
const autoToggle = document.getElementById("autoToggle");
const autoWrap = document.getElementById("autoWrap");
const shotToggle = document.getElementById("shotToggle");
const shotWrap = document.getElementById("shotWrap");
const thinkToggle = document.getElementById("thinkToggle");
const ctxInfo = document.getElementById("ctxInfo");
const statusEl = document.getElementById("status");
const attachBtn = document.getElementById("attachBtn");
const fileInput = document.getElementById("fileInput");
const attachListEl = document.getElementById("attachList");
const deferChip = document.getElementById("deferChip");
const deferChipText = document.getElementById("deferChipText");
const deferCancelBtn = document.getElementById("deferCancelBtn");
const wsBarEl = document.getElementById("wsBar");
const mergeBarEl = document.getElementById("mergeBar");

// ===== 全局状态 =====
let settings = null;
let windowId = null;

// 所有工作区：id -> { ws, rt }。ws 是持久化记录，rt 是运行时。
const workspaces = new Map();
// 当前激活（面板正在显示）的工作区 id
let activeWsId = null;
// 还没建工作区时，用户正在看的那个标签页（等首次发消息再建）
let pendingTabId = null;
// ===== 跨面板实例协作 =====
//
// Chrome 的侧栏是**每个标签页一份文档实例**：你切走再切回来，看到的那一份
// 很可能不是正在干活的那一份。它手里的会话、横条、"是否在运行"全是旧快照 ——
// 表现就是"看不到更新""横条不消失""AI 在跑但按钮还是发送""发消息像没发一样"。
//
// 解法：把"谁正在跑这一份工作区"写进**共享存储**并广播，并允许把动作
// （停止 / 发消息）**转交给真正在跑的那一份**执行。
const BUSY_PREFIX = "ai_busy_";
const busyKey = (wsId) => BUSY_PREFIX + wsId;
const BUSY_TTL = 30 * 60 * 1000; // 执行者异常退出时的兜底过期

async function markBusy(wsId, on) {
  if (!wsId) return;
  try {
    if (on) {
      await chrome.storage.local.set({ [busyKey(wsId)]: { by: panelInstanceId, at: Date.now() } });
    } else {
      const got = await chrome.storage.local.get(busyKey(wsId));
      const cur = got && got[busyKey(wsId)];
      // 只清自己写的（避免把别的一份正在跑的标记误删）
      if (cur && cur.by === panelInstanceId) await chrome.storage.local.remove(busyKey(wsId));
    }
  } catch (_) {}
  try {
    chrome.runtime.sendMessage({ type: "ws:busy", wsId, on: !!on }).catch(() => {});
  } catch (_) {}
}

// 把"别处正在跑"落到运行时上（只影响按钮状态，不影响本实例自己的 busy）
function applyRemoteBusy(wsId, on) {
  const entry = workspaces.get(wsId);
  if (!entry) return;
  if (entry.rt.busy) return; // 自己在跑，以自己为准
  entry.rt.remoteBusy = !!on;
  if (entry.ws.id === activeWsId) syncHeader(entry.rt);
}

// 读一次共享标记（切进来时用）
async function readRemoteBusy(wsId) {
  try {
    const got = await chrome.storage.local.get(busyKey(wsId));
    const cur = got && got[busyKey(wsId)];
    if (!cur) return false;
    if (cur.by === panelInstanceId) return false;
    if (Date.now() - (cur.at || 0) > BUSY_TTL) return false; // 过期兜底
    return true;
  } catch (_) {
    return false;
  }
}

// 找出这块工作区已经在运行的那个实例（用于转交）
function ownerOfWorkspace(wsId) {
  return workspaces.get(wsId)?.rt || null;
}

// 本面板实例的随机 id：用来"认领"唤醒、以及标记"谁在跑"
const panelInstanceId = Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);

// 输入框内容按工作区暂存（切页时不能串）
const drafts = new Map();

init();

// ===== 上下文接口：给 WorkspaceRuntime 用 =====
const runtimeCtx = {
  // 每轮开始时重新读一次设置：这样在设置页改完（阈值/重试参数/模型等）
// 不需要重载侧栏就能生效
  getSettings: async () => {
    try {
      settings = await getSettings();
    } catch (_) {}
    return settings;
  },
  fillInput: (text) => {
    inputEl.value = text;
    inputEl.focus();
  },
  toggleState: () => ({
    ctx: ctxToggle.checked,
    ctl: ctlToggle.checked,
    auto: autoToggle.checked,
    shot: shotToggle.checked && !shotToggle.disabled,
    think: thinkToggle.checked,
  }),
  onStateChange(rt) {
    // 非激活工作区也在后台跑。这里只刷新切换条上的"正在跑"小圆点，
    // 让用户知道"另一份在干活"，但**绝不切换视图**（不抢 UI、不打扰）。
    renderWsBar();
    if (rt.ws.id !== activeWsId) return; // 非激活工作区只更新圆点
    syncHeader(rt);
    setStatus(rt.status.text, rt.status.kind);
  },
  onDeferChange(rt) {
    if (rt.ws.id !== activeWsId) return;
    syncDeferChip(rt);
  },
  saveSession: (s) => saveSession(s),
  persist: () => persistAll(),
  markBusy: (wsId, on) => markBusy(wsId, on),
  // 用户此刻正在看的标签页（决定"这一轮该操作哪一页"）。
  // 不直接用缓存的 pendingTabId：headless / 多窗口下 lastFocusedWindow 可能滞后，
  // 每次现查一次最可靠；查不到再退回缓存值。
  async activeTabId() {
    if (windowId != null) {
      try {
        const [tab] = await chrome.tabs.query({ active: true, windowId });
        if (tab && tab.id != null) return tab.id;
      } catch (_) {}
    }
    return pendingTabId;
  },
  async getAliveTabs(rt) {
    const out = [];
    for (const id of rt.tabIds.slice()) {
      try {
        const t = await chrome.tabs.get(id);
        if (t) out.push(t);
      } catch (_) {
        // ⚠️ 取不到**不等于**标签页没了：页面正在跳转/重载的瞬间也可能取不到。
        // 这里只跳过、绝不摘除 —— 摘除交给 chrome.tabs.onRemoved（真正的关闭事件）。
        // 旧实现一失败就 removeTab，会把正在跳转的页从工作区里摘掉，
        // 进而让归属判定失败、面板切成空对话。
      }
    }
    return out;
  },
};

// ===== 初始化 =====
async function init() {
  settings = await getSettings();
  ctxToggle.checked = settings.contextEnabled !== false;
  thinkToggle.checked = settings.thinkingEnabled !== false;
  ctlToggle.checked = settings.controlEnabled !== false;
  autoToggle.checked = !!settings.autoExecute;
  windowId = await getOwnWindowId();

  renderModelOptions();
  syncShotToggle();
  syncAutoToggle();

  await restoreWorkspaces();
  await refreshActive();

  sendBtn.addEventListener("click", () => {
    const rt = activeRuntime();
    if (rt && rt.busy) {
      rt.abort();
      return;
    }
    // 这块工作区正在**别的面板实例**里跑：本实例不是执行者，
    // 广播一个停止请求，让真正在跑的那份停下来（否则这块按钮看起来点了没反应）
    if (rt && rt.remoteBusy) {
      try {
        chrome.runtime.sendMessage({ type: "ws:abort", wsId: rt.ws.id }).catch(() => {});
      } catch (_) {}
      setStatus("已请求停止（任务在另一个面板里运行）", "");
      return;
    }
    onSend();
  });
  new MutationObserver(() => {
    sendBtn.title = sendBtn.classList.contains("streaming") ? "停止" : "发送";
  }).observe(sendBtn, { attributes: true, attributeFilter: ["class"] });

  newChatBtn.addEventListener("click", startNewChat);
  settingsBtn.addEventListener("click", () => chrome.runtime.openOptionsPage());
  historyBtn.addEventListener("click", openHistory);
  historyCloseBtn.addEventListener("click", () => historyPanel.classList.add("hidden"));

  ctxToggle.addEventListener("change", async () => {
    await patchSettings({ contextEnabled: ctxToggle.checked });
    await refreshCtxInfo();
  });
  ctlToggle.addEventListener("change", async () => {
    await patchSettings({ controlEnabled: ctlToggle.checked });
    syncAutoToggle();
  });
  autoToggle.addEventListener("change", async () => {
    await patchSettings({ autoExecute: autoToggle.checked });
  });
  thinkToggle.addEventListener("change", async () => {
    await patchSettings({ thinkingEnabled: thinkToggle.checked });
  });
  // 模型切换：只改当前工作区（不同工作区可以用不同模型，也支持中途改）
  modelSelect.addEventListener("change", () => {
    const [pid, mid] = modelSelect.value.split("::");
    void patchSettings({ activeProviderId: pid, activeModelId: mid });
    const rt = activeRuntime();
    if (rt) {
      rt.ws.providerId = pid;
      rt.ws.modelId = mid;
      persistAll();
    }
    syncShotToggle();
    renderWsBar();
  });

  attachBtn.addEventListener("click", () => fileInput.click());
  fileInput.addEventListener("change", async () => {
    await addFiles([...fileInput.files]);
    fileInput.value = "";
  });
  inputEl.addEventListener("paste", async (e) => {
    const imgs = imagesFromClipboard(e);
    if (imgs.length) {
      e.preventDefault();
      await addFiles(imgs);
    }
  });
  inputEl.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      const rt = activeRuntime();
      if (!rt || !rt.busy) onSend();
    }
  });
  // 输入框内容按工作区暂存
  inputEl.addEventListener("input", () => {
    if (activeWsId) drafts.set(activeWsId, inputEl.value);
    else drafts.set("__pending__", inputEl.value);
  });

  deferCancelBtn.addEventListener("click", () => {
    const rt = activeRuntime();
    if (rt) rt.cancelActiveDefer();
  });

  // 标签页事件
  //
  // ⚠️ 这里**故意不做窗口过滤**：重算本身是安全的（`activeTab()` 永远只看本窗口的当前页），
  //    所以别的窗口的活动最多引起一次"无变化的重算"。
  //    反过来，一旦过滤条件算错（面板的 windowId 判断失准），本窗口的标签页切换会被
  //    全部忽略 → 视图**卡住不动**，切到没有工作区的页也还显示上一个会话
  //    （用户反馈："切换标签页，不在工作区的标签页侧栏显示的不是新对话"）。
  //    凡是"改状态"的事件（onCreated / onRemoved / onReplaced）都按**标签页是否属于
  //    我的工作区**来判断（tabId 全局唯一），也不需要窗口过滤。
  chrome.tabs.onActivated.addListener(() => {
    refreshActive();
  });
  chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
    if (changeInfo.status !== "complete") return;
    refreshActive();
  });
  chrome.tabs.onRemoved.addListener((tabId) => {
    onTabRemoved(tabId);
  });

  // 标签页被"替换"：浏览器预渲染 / Instant 导航会换掉 tabId，
  // **视觉上完全看不出来**（没有新标签页、也没有切换标签页）。
  //
  // 不处理的话，工作区里记的还是旧 id，于是当前页被判成"不属于任何工作区"
  // → 面板切成初始页（用户反馈："点视频链接就回到新对话页面"，同一标签页内）。
  // 注意 onReplaced 是**代替** onCreated/onRemoved 触发的，所以必须单独接。
  chrome.tabs.onReplaced.addListener((addedTabId, removedTabId) => {
    transferTab(removedTabId, addedTabId);
    refreshActive();
  });
  chrome.tabs.onCreated.addListener((t) => {
    noteOpenedTab(t);

    // 新页只按 **opener 关系**认领，而且必须满足"这个工作区刚做完一个动作"：
    // 只有 AI 的动作弹出来的页，才算这个工作区开的（target=_blank / window.open 都带 opener）。
    //
    // ⚠️ 曾经有两条"宽进"逻辑，都已删除，别再改回去：
    //   ① 用"最近出现的新页 + 有工作区在跑"去兜底认领 —— 会把**用户自己开的新标签页**
    //      吸进 AI 的工作区（用户反馈：切到没被 AI 用过的标签页，侧栏却不是新对话）；
    //   ② 认领后立刻 activateWorkspace —— 直接把视图从用户正在看的页面抢走。
    // 现在只并入、不抢视图；等这个页真的成为当前页时，refreshActive 自然会显示对应工作区。
    if (t.openerTabId == null) return;
    const ws = wsOfTab(t.openerTabId);
    const entry = ws ? workspaces.get(ws.id) : null;
    if (!entry) return;
    const justActed =
      entry.rt.busy && entry.rt.lastActionAt && Date.now() - entry.rt.lastActionAt < 3000;
    if (!justActed) return;
    if (entry.rt.addTab(t.id)) {
      ws.rootTabId = t.id; // 新页成为该工作区当前目标
      persistAll();
      renderWsBar();
    }
  });

  // SW 推来的唤醒 + 面板实例之间的协作消息
  chrome.runtime.onMessage.addListener((msg) => {
    if (!msg || typeof msg !== "object") return;

    if (msg.type === "defer:wake" && msg.wake) {
      routeWake(msg.wake);
      return;
    }

    // 另一份面板开始/结束运行这块工作区 → 更新自己的按钮状态
    if (msg.type === "ws:busy" && msg.wsId) {
      applyRemoteBusy(msg.wsId, msg.on);
      return;
    }

    // 另一份面板请求停止 → 只有真正在跑的那份会响应
    if (msg.type === "ws:abort" && msg.wsId) {
      const rt = ownerOfWorkspace(msg.wsId);
      if (rt && rt.busy) rt.abort();
      return;
    }

    // 另一份面板把用户消息转交过来（它自己不是执行者）→ 接着跑
    if (msg.type === "ws:send" && msg.wsId && msg.text) {
      const rt = ownerOfWorkspace(msg.wsId);
      if (!rt) return;
      if (rt.busy) rt.pendingSends.push({ text: msg.text, attachments: msg.attachments || [] });
      else rt.send({ text: msg.text, attachments: msg.attachments || [] }).catch(() => {});
    }
  });

  // 侧栏可能在条件满足时没开着 → SW 把唤醒暂存在 storage，开屏时补发
  try {
    const resp = await chrome.runtime.sendMessage({ type: "defer:consume" });
    if (resp && resp.wake) {
      setTimeout(() => routeWake(resp.wake), 400);
    }
  } catch (_) {}

  // 别的上下文（另一份侧栏文档 / 另一个窗口）写了存储 → 本视图跟着刷新。
  // 这是"我明明就在这个会话里，却看不到更新"的正解：不依赖"重新进入"。
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;

    // 会话被更新：如果正是当前显示的那份，且自己没在跑，就换上新内容并重绘
    const sess = changes["ai_browser_sessions"];
    if (sess) {
      const rt = activeRuntime();
      if (rt && !rt.busy) {
        const fresh = (sess.newValue || []).find((s) => s.id === rt.ws.sessionId);
        if (fresh) {
          const cur = rt.session || {};
          const changed =
            fresh.updatedAt !== cur.updatedAt ||
            (fresh.messages || []).length !== (cur.messages || []).length;
          if (changed) {
            rt.session = fresh;
            rt.renderSession();
          }
        }
      }
    }

    // 后台任务表被更新：任务已不在表里（已完成/已取消）→ 收起横条
    if (changes["ai_defer_tasks"]) {
      const rt = activeRuntime();
      if (rt && rt.activeDeferTask) {
        const tasks = changes["ai_defer_tasks"].newValue || {};
        if (!tasks[rt.activeDeferTask.id]) {
          rt.activeDeferTask = null;
          syncDeferChip(rt);
        }
      }
    }

    // 共享的"正在运行"标记变了 → 按钮状态跟着变（发送 ↔ 停止）
    for (const k of Object.keys(changes)) {
      if (!k.startsWith(BUSY_PREFIX)) continue;
      const wsId = k.slice(BUSY_PREFIX.length);
      const nv = changes[k].newValue;
      applyRemoteBusy(wsId, !!(nv && nv.by !== panelInstanceId));
    }
  });
}

// ===== 工作区持久化 =====
function persistAll() {
  if (windowId == null) return;
  const list = [];
  for (const { ws } of workspaces.values()) {
    if (!ws.tabIds.length) continue;
    list.push({
      id: ws.id,
      rootTabId: ws.rootTabId,
      tabIds: ws.tabIds.slice(),
      sessionId: ws.sessionId,
      providerId: ws.providerId,
      modelId: ws.modelId,
      createdAt: ws.createdAt,
    });
  }
  saveWorkspaces(windowId, list).catch(() => {});
}

// 恢复上次的工作区（侧栏刷新/重开不该丢）
async function restoreWorkspaces() {
  if (windowId == null) return;
  const { list } = await loadWorkspaces(windowId);
  if (!list.length) return;

  // ⚠️ 拿不到标签页列表时**什么都别做**：跳过恢复，且绝不能往下走 persistAll()
  //    —— 那会把"内存里没有工作区"写回 storage，等于把记录抹掉。
  let tabs;
  try {
    tabs = await chrome.tabs.query({ windowId });
  } catch (_) {
    return;
  }
  if (!tabs.length) return; // 窗口刚开、标签页还没就绪：下次事件再恢复

  const aliveIds = new Set(tabs.map((t) => t.id));
  const sessions = await listSessions();

  for (const w of list) {
    const tabIds = (w.tabIds || []).filter((id) => aliveIds.has(id));
    if (!tabIds.length) continue;
    if (!tabIds.includes(w.rootTabId)) w.rootTabId = tabIds[0];
    const ws = { ...w, tabIds };
    let sess = sessions.find((s) => s.id === ws.sessionId);
    if (!sess) {
      // 会话确实不见了（极少见）：建一个空的顶上，但要留下痕迹，别让用户以为"对话凭空没了"
      sess = newSession(ws.id);
      console.warn("[ws] 会话记录缺失，已新建空会话：", ws.sessionId, "->", sess.id);
    }
    ws.sessionId = sess.id;
    sess.workspaceId = ws.id;
    const rt = new WorkspaceRuntime({ ws, session: sess, ctx: runtimeCtx });
    rt.renderSession();
    workspaces.set(ws.id, { ws, rt });
  }
  persistAll();
}

// ===== 当前激活 =====

// 面板**自己所在的窗口**。
//
// ⚠️ 这是多窗口场景的关键：以前用 lastFocusedWindow 判断"用户在哪一页"，
//    结果用户在另一个窗口刷视频时，本窗口的面板会去查"那个窗口的当前标签页"，
//    发现它不属于本窗口的任何工作区 → 把面板切成初始空对话（跨窗口串台）。
//    windows.getCurrent() 返回的是"承载本面板的那个窗口"，才是我们的锚点。
async function getOwnWindowId() {
  try {
    const w = await chrome.windows.getCurrent();
    if (w && w.id != null) return w.id;
  } catch (_) {}
  // 兜底：拿不到就问"最近聚焦的窗口"（单窗口场景下等价）
  return await currentWindowId();
}

// 兜底用：最近聚焦窗口的 id（只在拿不到"自己窗口"时用）
async function currentWindowId() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (tab && tab.windowId != null) return tab.windowId;
  } catch (_) {}
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab && tab.windowId != null) return tab.windowId;
  } catch (_) {}
  return null;
}

// 本窗口当前正在看的那一页。
//
// ⚠️ 必须限定在**面板自己的窗口**里查：用 lastFocusedWindow 会在多窗口时
//    查到别的窗口的标签页，把工作区判定成"未归属"（跨窗口串台）。
//
// 顺序：currentWindow →（缓存的）windowId → lastFocusedWindow。
// `currentWindow` 对扩展页面（含侧栏）就是"承载本面板的窗口"，最权威；
// 用它顺手**自愈**我们缓存的 windowId —— 万一一开始算错了，这里会纠正回来。
async function activeTab() {
  try {
    const [t] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (t && t.id) {
      if (t.windowId != null && windowId !== t.windowId) windowId = t.windowId;
      return t;
    }
  } catch (_) {}
  if (windowId != null) {
    try {
      const [t] = await chrome.tabs.query({ active: true, windowId });
      if (t && t.id) return t;
    } catch (_) {}
  }
  try {
    const [t] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (t && t.id) return t;
  } catch (_) {}
  return null;
}

// 标签页被浏览器"替换"（预渲染 / Instant 导航）时，把工作区里的旧 id 换成新 id。
//
// 为什么必须有这一步：这种替换**视觉上无感** —— 没有新标签页、也没有切换动作，
// 但 tabId 变了。工作区如果不跟着换，归属判定就会失败，面板会切成初始页。
function transferTab(oldId, newId) {
  if (oldId == null || newId == null || oldId === newId) return false;
  for (const { ws, rt } of workspaces.values()) {
    if (!ws.tabIds.includes(oldId)) continue;
    rt.removeTab(oldId);
    rt.addTab(newId);
    if (ws.rootTabId === oldId) ws.rootTabId = newId;
    persistAll();
    renderWsBar();
    return true;
  }
  return false;
}

// 找出某个标签页属于哪个工作区
function wsOfTab(tabId) {
  if (tabId == null) return null;
  for (const { ws } of workspaces.values()) {
    if (ws.tabIds.includes(tabId)) return ws;
  }
  return null;
}

function activeRuntime() {
  if (!activeWsId) return null;
  return workspaces.get(activeWsId)?.rt || null;
}

// 切标签页 / 页面加载完 → 重新决定面板显示哪份工作区
async function refreshActive() {
  const cur = await activeTab();
  const tabId = cur?.id ?? null;
  const ws = wsOfTab(tabId);

  if (ws) {
    // 属于某个工作区 → 激活它
    pendingTabId = tabId;
    activateWorkspace(ws.id);
    await refreshCtxInfo();
    return;
  }

  // 走到这里：当前页不属于任何工作区 → 就显示这个页面的"空对话"。
  //
  // ⚠️ 这里**只允许**看"当前这一页本身"，绝不能因为"别的页有工作区在跑"就把视图切过去。
  //    曾经有过"刚出现的新页 + 有工作区在跑 → 切到那个工作区"的兜底，结果：
  //    用户在标签页2 浏览时，标签页1 的后台任务一续跑，视图就被拽到标签页1 的会话上，
  //    看起来就像"后台任务的句子发到了我眼前的会话里"（用户报告）。
  //    后台续跑该在它自己的工作区里悄悄进行；要看就切回那一页。
  //
  // 诊断：本窗口明明还有工作区，却把当前页判成"未归属" —— 这通常就是
  // "同一标签页里点了链接，面板却回到初始页"的现场。把关键事实打出来，
  // 便于定位到底是 tabId 变了、还是工作区里记的 id 不对（正常使用不会有这行）。
  if (workspaces.size > 0) {
    console.info("[ws] 归属失败 → 显示初始页", {
      activeTabId: tabId,
      activeUrl: cur ? cur.url : "",
      workspaces: [...workspaces.values()].map(({ ws, rt }) => ({
        id: ws.id,
        rootTabId: ws.rootTabId,
        tabIds: ws.tabIds.slice(),
        busy: !!rt.busy,
      })),
    });
  }
  pendingTabId = tabId;
  activatePending(tabId, cur);
  await refreshCtxInfo();
}

function activateWorkspace(id) {
  if (activeWsId === id) {
    // 已经是它：只刷新头部
    const rt = workspaces.get(id)?.rt;
    if (rt) {
      syncHeader(rt);
      void healWorkspaceView(rt);
    }
    return;
  }
  // 暂存当前输入框
  if (activeWsId) drafts.set(activeWsId, inputEl.value);

  activeWsId = id;
  const entry = workspaces.get(id);
  if (!entry) return;
  const { rt } = entry;

  // 换 DOM：非激活工作区的 chat 脱离文档但仍在跑
  chatHost.innerHTML = "";
  chatHost.appendChild(rt.chatEl);
  rt.scrollChat();

  renderWsBar();
  syncHeader(rt);
  setStatus(rt.status.text, rt.status.kind);
  syncDeferChip(rt);
  renderAttachments(rt);
  inputEl.value = drafts.get(id) || "";
  inputEl.focus();
  // 切进来时自愈：把"可能是旧快照"的会话/横条状态同步成最新的
  void healWorkspaceView(rt);
}

// ===== 视图自愈 =====
//
// 为什么需要：Chrome 的侧栏是**每个标签页一份文档实例**。你离开某个标签页再回来时，
// 显示给你的那一份，可能不是正在干活的那一份 —— 它手里的会话是**旧快照**，
// 后台任务横条的状态也是旧的。表现就是：
//   · "我需要一次次从历史会话点进来才看得到更新"
//   · "离开标签页再回来，横条不消失，从历史点进来也不消失"
// 这里在"切到这份工作区"时做两件事，和具体是哪份文档无关：
//   ① 后台任务若已不在 SW 的任务表里（已完成/已取消）→ 收起横条
//   ② 这份运行时此刻没在跑，就把它的会话按 storage 里的最新版重绘
async function healWorkspaceView(rt) {
  if (!rt) return;

  // ⓪ "在别处运行"标记：读共享存储，修正按钮状态（发送 ↔ 停止）
  if (!rt.busy) {
    const remote = await readRemoteBusy(rt.ws.id);
    if (rt.remoteBusy !== remote) {
      rt.remoteBusy = remote;
      if (rt.ws.id === activeWsId) syncHeader(rt);
    }
  }

  // ① 横条：以 SW 的任务表为准（任务表是全局唯一真相）
  if (rt.activeDeferTask) {
    try {
      const resp = await chrome.runtime.sendMessage({ type: "defer:list" });
      const still = ((resp && resp.tasks) || []).some((t) => t.id === rt.activeDeferTask.id);
      if (!still) {
        rt.activeDeferTask = null;
        if (rt.ws.id === activeWsId) syncDeferChip(rt);
      }
    } catch (_) {}
  }

  // ② 会话：正在跑的这份自己会更新，别覆盖它
  if (rt.busy) return;
  try {
    const sessions = await listSessions();
    const fresh = sessions.find((s) => s.id === rt.ws.sessionId);
    if (!fresh) return;
    const cur = rt.session || {};
    const changed =
      fresh.updatedAt !== cur.updatedAt ||
      (fresh.messages || []).length !== (cur.messages || []).length;
    if (!changed) return;
    rt.session = fresh;
    if (rt.ws.id === activeWsId) rt.renderSession();
  } catch (_) {}
}

// 未建工作区的页面：显示空对话（这个页面的"草稿态"）
function activatePending(tabId, tab) {
  if (activeWsId) drafts.set(activeWsId, inputEl.value);
  activeWsId = null;

  chatHost.innerHTML = "";
  const holder = document.createElement("div");
  holder.className = "chat";
  holder.innerHTML = `
    <div class="empty-hint">
      <div class="orb">
        <img src="../assets/icon128.png" alt="青鸟" />
      </div>
      <h3>青鸟</h3>
      <p class="sub">对着当前网页提问，或让我直接操作页面<br/><span class="pending-note">发送第一条消息时会为这个页面建立独立工作区</span></p>
      <div class="suggestions">
        <button data-fill="总结一下当前页面的要点">总结当前页面</button>
        <button data-fill="帮我在这个页面上找到并填写表单">帮我填表</button>
        <button data-fill="这个页面讲了什么？有哪些关键信息？">页面要点</button>
        <button data-fill="帮我点击页面上的关键操作，并说明每一步">代我操作</button>
      </div>
    </div>`;
  for (const b of holder.querySelectorAll(".suggestions button")) {
    b.addEventListener("click", () => {
      inputEl.value = b.dataset.fill || b.textContent || "";
      inputEl.focus();
    });
  }
  chatHost.appendChild(holder);

  renderWsBar();
  ctxInfo.textContent = tab && tab.title ? tab.title : "";
  ctxInfo.title = tab && tab.url ? tab.url : "";
  setStatus("", "");
  syncDeferChip(null);
  renderAttachments(null);
  inputEl.value = drafts.get("__pending__") || "";
  inputEl.focus();
}

// ===== 工作区切换条 =====
function renderWsBar() {
  renderMergeBar(); // 顺带刷新"并入"入口（它依赖当前页是否已归属）
  if (!wsBarEl) return;
  const list = [...workspaces.values()].filter(({ ws }) => ws.tabIds.length);
  if (list.length <= 1) {
    wsBarEl.classList.add("hidden");
    wsBarEl.innerHTML = "";
    return;
  }
  wsBarEl.classList.remove("hidden");
  wsBarEl.innerHTML = "";
  for (const { ws, rt } of list) {
    const chip = document.createElement("button");
    chip.className = "ws-chip" + (ws.id === activeWsId ? " active" : "");
    chip.type = "button";
    const title = (rt.targetPageLabel || "").slice(0, 14) || ws.tabIds.length + " 个页面";
    chip.textContent = title;
    chip.title = ws.tabIds.length + " 个标签页" + (rt.busy ? " · 正在运行" : "");
    if (rt.busy) {
      const dot = document.createElement("i");
      dot.className = "ws-dot";
      chip.appendChild(dot);
    }
    chip.addEventListener("click", async () => {
      // 点 chip → 切到那个工作区的根标签页
      try {
        await chrome.tabs.update(ws.rootTabId, { active: true });
      } catch (_) {}
      activateWorkspace(ws.id);
    });
    wsBarEl.appendChild(chip);
  }
}

// ===== 手动并入 / 移出 =====
// 并入：你自己新开一个标签页想接着同一件事干时，按规则它会被当成"新工作区"，
//       反而把一件事拆散。这里给一个显式出口，把它并进你选的那一份工作区。
// 移出：反过来，如果某个页**被误吸进了工作区**（本该是它自己的新对话），
//       给它一个出口把这页分出去，立刻恢复成独立的新对话。
function renderMergeBar() {
  if (!mergeBarEl) return;
  mergeBarEl.innerHTML = "";
  const list = [...workspaces.values()].filter(({ ws }) => ws.tabIds.length);
  const cur = pendingTabId != null ? wsOfTab(pendingTabId) : null;

  // ① 当前页已归属：给"移出工作区"出口（只在工作区不止一页时才有意义，
  //    否则移出去工作区就空了、连会话一起删，容易误操作）
  if (cur) {
    if (cur.tabIds.length < 2) {
      mergeBarEl.classList.add("hidden");
      return;
    }
    mergeBarEl.classList.remove("hidden");
    const out = document.createElement("button");
    out.className = "tiny";
    out.textContent = "把这页移出工作区";
    out.title = "让这一页恢复成它自己的独立对话（不再和这个工作区共用同一份对话）";
    out.addEventListener("click", () => detachCurrentFromWorkspace(cur.id));
    mergeBarEl.appendChild(out);
    return;
  }

  // ② 当前页未归属：给"并入"出口
  if (!list.length) {
    mergeBarEl.classList.add("hidden");
    return;
  }
  mergeBarEl.classList.remove("hidden");
  const btn = document.createElement("button");
  btn.className = "tiny";
  btn.textContent = `并入已有工作区（${list.length}）`;
  btn.title = "把当前标签页加入某个已有工作区，和它一起共用同一份对话与模型";
  btn.addEventListener("click", () => {
    mergeBarEl.innerHTML = "";
    for (const { ws, rt } of list) {
      const chip = document.createElement("button");
      chip.className = "tiny";
      chip.type = "button";
      chip.textContent = (rt.targetPageLabel || "").slice(0, 14) || ws.tabIds.length + " 个页面";
      chip.title = "把当前标签页并入这个工作区";
      chip.addEventListener("click", () => mergeCurrentIntoWorkspace(ws.id));
      mergeBarEl.appendChild(chip);
    }
    const cancel = document.createElement("button");
    cancel.className = "tiny";
    cancel.textContent = "取消";
    cancel.addEventListener("click", () => renderMergeBar());
    mergeBarEl.appendChild(cancel);
  });
  mergeBarEl.appendChild(btn);
}

// 把当前页从它所属的工作区里摘出去 → 这一页变回它自己的新对话
async function detachCurrentFromWorkspace(wsId) {
  const entry = workspaces.get(wsId);
  const tabId = pendingTabId;
  if (!entry || tabId == null) return;
  entry.rt.removeTab(tabId);
  if (entry.ws.rootTabId === tabId) entry.ws.rootTabId = entry.ws.tabIds[0];
  persistAll();
  renderWsBar();
  await refreshActive();
  setStatus("已把这页移出工作区，现在是它自己的新对话", "ok");
  inputEl.focus();
}

async function mergeCurrentIntoWorkspace(wsId) {
  const entry = workspaces.get(wsId);
  const tabId = pendingTabId;
  if (!entry || tabId == null) return;
  if (!entry.rt.addTab(tabId)) {
    renderMergeBar();
    return;
  }
  entry.ws.rootTabId = tabId; // 并进来之后，当前页就是这份工作区的目标页
  persistAll();
  await refreshActive(); // 直接切到那份工作区
  setStatus("已把当前页并入该工作区", "ok");
  inputEl.focus();
}

// ===== 头部同步 =====
function syncHeader(rt) {
  // 模型下拉：跟随当前工作区（每个工作区可不同）
  const pid = rt.ws.providerId || settings.activeProviderId;
  const mid = rt.ws.modelId || settings.activeModelId;
  const v = `${pid}::${mid}`;
  if (modelSelect.value !== v && [...modelSelect.options].some((o) => o.value === v)) {
    modelSelect.value = v;
  }
  syncShotToggle();
  if (ctxInfo) {
    const t = rt.targetPageLabel;
    ctxInfo.textContent = t || "";
    ctxInfo.title = t || "";
  }
  // 发送/停止按钮状态
  // 「在别处运行」也要显示成停止态，否则用户会以为没跑、或以为消息没发出去
  if (rt.busy || rt.remoteBusy) sendBtn.classList.add("streaming");
  else sendBtn.classList.remove("streaming");
}

function syncDeferChip(rt) {
  const task = rt && rt.activeDeferTask;
  if (!task) {
    deferChip.classList.add("hidden");
    return;
  }
  deferChipText.textContent = `后台任务：${rt.deferLabel(task)}，满足后自动继续`;
  deferChipText.title = task.instruction || "";
  deferChip.classList.remove("hidden");
}

async function refreshCtxInfo() {
  if (activeWsId) return; // 激活工作区时由 syncHeader 负责
  if (!ctxToggle.checked && !ctlToggle.checked) {
    ctxInfo.textContent = "";
    return;
  }
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab && tab.url && !/^https?:/.test(tab.url)) {
      ctxInfo.textContent = (tab.title || "浏览器内置页") + " · 内置页读不到元素，可让 AI 跳转网址";
      ctxInfo.title = tab.url;
      return;
    }
    ctxInfo.textContent = tab && tab.title ? tab.title : "";
    ctxInfo.title = tab && tab.title ? tab.title : "";
  } catch (_) {
    ctxInfo.textContent = "";
  }
}

// ===== 建立 / 销毁工作区 =====
function createWorkspaceForTab(tabId, tab) {
  const pid = settings.activeProviderId;
  const mid = settings.activeModelId;
  const ws = newWorkspace(tabId, pid, mid);
  const sess = newSession(ws.id);
  ws.sessionId = sess.id;
  const rt = new WorkspaceRuntime({ ws, session: sess, ctx: runtimeCtx });
  workspaces.set(ws.id, { ws, rt });
  persistAll();
  activateWorkspace(ws.id);
  return rt;
}

// 标签页被关 → 从工作区移除；全空则该工作区消失并删掉会话
function onTabRemoved(tabId) {
  for (const [id, { ws, rt }] of [...workspaces.entries()]) {
    if (!ws.tabIds.includes(tabId)) continue;
    rt.removeTab(tabId);
    if (!ws.tabIds.length) {
      // 工作区消失 → 会话一并删除（用户明确要求）
      rt.destroy();
      workspaces.delete(id);
      if (ws.sessionId) deleteSessionsOfWorkspace(ws.id).catch(() => {});
      if (activeWsId === id) {
        activeWsId = null;
      }
    } else if (ws.rootTabId === tabId) {
      ws.rootTabId = ws.tabIds[0];
    }
  }
  persistAll();
  renderWsBar();
  if (!activeWsId) refreshActive();
}

// ===== 发送 =====
async function onSend() {
  const text = inputEl.value.trim();
  // 先按"用户此刻所在的标签页"决定发给哪份工作区：
  // 它可能属于某份工作区（那就是切过去继续那份对话），也可能还没归属（新建一份）。
  const curTabId = pendingTabId;
  const wsOfCur = wsOfTab(curTabId);
  if (wsOfCur && wsOfCur.id !== activeWsId) {
    activateWorkspace(wsOfCur.id);
  }
  const rt = activeRuntime();

  if (!rt) {
    // 还没有工作区 → 用当前标签页建一个（懒创建）
    const cur = curTabId != null ? { id: curTabId } : await activeTab();
    if (!cur || cur.id == null) {
      setStatus("找不到当前标签页", "err");
      return;
    }
    if (!text && !currentAttachments().length) return;
    const newRt = createWorkspaceForTab(cur.id, cur);
    // 把草稿态的附件带过去
    newRt.attachments = currentAttachments();
    pendingAttachments = [];
    inputEl.value = "";
    const atts = newRt.attachments.slice();
    newRt.attachments = [];
    renderAttachments(newRt);
    await newRt.send({ text, attachments: atts });
    return;
  }

  if (rt.busy) return;
  if (!text && !rt.attachments.length) return;

  // 这块工作区正在**别的面板实例**里跑：把消息转交给它，别让用户觉得"发了跟没发一样"。
  // （Chrome 侧栏是每标签页一份文档实例，你切回来的那份往往不是执行者。）
  if (rt.remoteBusy) {
    const atts = rt.attachments.slice();
    rt.attachments = [];
    renderAttachments(rt);
    inputEl.value = "";
    try {
      chrome.runtime.sendMessage({
        type: "ws:send",
        wsId: rt.ws.id,
        text,
        attachments: atts,
      }).catch(() => {});
    } catch (_) {}
    setStatus("已把这条消息交给正在运行的那份面板", "ok");
    return;
  }

  inputEl.value = "";
  const atts = rt.attachments.slice();
  rt.attachments = [];
  renderAttachments(rt);
  await rt.send({ text, attachments: atts });
}

// 未建工作区时，附件先存在一个临时数组里
let pendingAttachments = [];
function currentAttachments() {
  const rt = activeRuntime();
  return rt ? rt.attachments : pendingAttachments;
}

function renderAttachments(rt) {
  const list = rt ? rt.attachments : pendingAttachments;
  attachListEl.innerHTML = "";
  list.forEach((a, i) => {
    const chip = document.createElement("div");
    chip.className = "attach-chip";
    if (a.kind === "image" && a.dataUrl) {
      const img = document.createElement("img");
      img.src = a.dataUrl;
      chip.appendChild(img);
    }
    const name = document.createElement("span");
    name.className = "name";
    name.textContent = a.name;
    name.title = a.name;
    chip.appendChild(name);
    const rm = document.createElement("button");
    rm.className = "rm";
    rm.textContent = "×";
    rm.title = "移除";
    rm.addEventListener("click", () => {
      list.splice(i, 1);
      renderAttachments(rt);
    });
    chip.appendChild(rm);
    attachListEl.appendChild(chip);
  });
}

async function addFiles(files) {
  const rt = activeRuntime();
  const list = rt ? rt.attachments : pendingAttachments;
  for (const f of files) {
    try {
      setStatus("处理附件：" + f.name + "…", "busy");
      const item = await processFile(f);
      list.push(item);
    } catch (err) {
      setStatus("附件失败：" + (err.message || err), "err");
    }
  }
  setStatus("");
  renderAttachments(rt);
}

// ===== 新对话 =====
function startNewChat() {
  const rt = activeRuntime();
  if (!rt) {
    // 当前页还没有工作区 → 先建（用户要求：没有工作区就自动创建）
    const cur = pendingTabId != null ? { id: pendingTabId } : null;
    if (!cur) {
      activeTab().then((t) => {
        if (t) createWorkspaceForTab(t.id, t);
      });
      return;
    }
    createWorkspaceForTab(cur.id, cur);
    return;
  }
  // 当前工作区内开新对话（只影响这一份，其它工作区不受影响）
  const sess = newSession(rt.ws.id);
  rt.session = sess;
  rt.ws.sessionId = sess.id;
  rt.activeDeferTask = null;
  rt.renderSession();
  rt.setStatus("", "");
  syncDeferChip(rt);
  persistAll();
  // 立刻落盘这条新会话：否则工作区记着一个存储里不存在的 sessionId，
  // 一旦这期间侧栏被重开，就只能凭空造一个空会话（看起来像"会话丢了"）
  saveSession(sess).catch(() => {});
  inputEl.focus();
}

// 改设置：**先读回外部改动再合并**，再写。
// 直接 saveSettings(settings) 会把面板内存里的整份设置写回去，覆盖掉设置页刚改的东西
// （实测：设置页改了"重试参数/上下文上限"，一切换模型就被打回旧值）。
async function patchSettings(patch) {
  try {
    const fresh = await getSettings();
    settings = { ...fresh, ...patch };
  } catch (_) {
    settings = { ...settings, ...patch };
  }
  await saveSettings(settings);
}

// ===== 唤醒路由 =====

// 认领一次唤醒（先写后读，谁写到最后谁是执行者）。
//
// 为什么必须做：`defer:wake` 是 chrome.runtime.sendMessage 广播 —— **所有扩展页面都会收到**。
// 多份面板文档（多个标签页 / 多个窗口）都会拿到同一次唤醒，如果各自都去跑一轮，
// 任务虽然只有一个，API 请求却会成倍发出去 → 429 限流（用户反馈"刚执行一条指令就 429"）。
async function claimWake(taskId) {
  if (!taskId) return true; // 老任务没有 id：不拦（宁可重复也不要漏跑）
  const key = `ai_defer_claim_${taskId}`;
  const CLAIM_TTL = 5 * 60 * 1000;
  try {
    const got = await chrome.storage.local.get(key);
    const cur = got && got[key];
    if (cur && cur.by !== panelInstanceId && Date.now() - (cur.at || 0) < CLAIM_TTL) {
      return false; // 已经被别的面板认领
    }
    await chrome.storage.local.set({ [key]: { by: panelInstanceId, at: Date.now() } });
    const again = await chrome.storage.local.get(key);
    const now = again && again[key];
    return !!(now && now.by === panelInstanceId); // 只有写到最后的面板能执行
  } catch (_) {
    return true; // 存储异常时不拦（宁可重复也不要漏跑）
  }
}

async function routeWake(wake) {
  if (!wake) return;
  // 唤醒必须回到"它自己那一份工作区"去续跑 —— 哪怕用户此刻看着别的页面、
  // 那份工作区不是激活状态（多工作区并发运行，各跑各的）。
  //
  // ⚠️ 硬规则：**只认 workspaceId**。它指出来的工作区在本窗口找不到 → 直接丢弃这个唤醒，
  //    绝不"退回到当前显示的那份"——那正是用户报告的
  //    "标签页1 的后台任务，句子出现在我正看的标签页2 会话里"。
  //    （旧任务没有 workspaceId 时才允许按 tabId 兜一次。）
  let target = null;
  if (wake.workspaceId) {
    target = workspaces.get(wake.workspaceId)?.rt || null;
    // 内存里没有（侧栏刚重开 / 被清过）→ 从**本窗口**的持久化里补一份出来
    if (!target) {
      target = await reviveWorkspace(wake.workspaceId);
    }
    if (!target) {
      console.warn("[ws] 唤醒的工作区不属于本窗口，已丢弃：", wake.workspaceId);
      return;
    }
  } else if (wake.tabId != null) {
    const ws = wsOfTab(wake.tabId);
    if (ws) target = workspaces.get(ws.id)?.rt || null;
  }
  if (!target) return;

  // 认领：同一个唤醒只允许一个面板执行（defer:wake 是广播，会被所有扩展页面收到）
  const claimed = await claimWake(wake.taskId);
  if (!claimed) return;

  // 已接管 → 清掉 SW 里那份"待消费"记录，避免下次面板初始化时又把它跑一遍
  try {
    chrome.runtime.sendMessage({ type: "defer:ack", taskId: wake.taskId }).catch(() => {});
  } catch (_) {}

  target.wake(wake).catch(() => {});
}

// 按 workspaceId 从持久化恢复一份运行时（内存里没有时用）
async function reviveWorkspace(workspaceId) {
  if (windowId == null) return null;
  const { list } = await loadWorkspaces(windowId);
  const w = list.find((x) => x.id === workspaceId);
  if (!w) return null;
  const tabs = await chrome.tabs.query({ windowId }).catch(() => []);
  const aliveIds = new Set(tabs.map((t) => t.id));
  const tabIds = (w.tabIds || []).filter((id) => aliveIds.has(id));
  if (!tabIds.length) return null;
  const ws = { ...w, tabIds, rootTabId: tabIds.includes(w.rootTabId) ? w.rootTabId : tabIds[0] };
  const sessions = await listSessions();
  const sess = sessions.find((s) => s.id === ws.sessionId) || newSession(ws.id);
  ws.sessionId = sess.id;
  sess.workspaceId = ws.id;
  const rt = new WorkspaceRuntime({ ws, session: sess, ctx: runtimeCtx });
  rt.renderSession();
  workspaces.set(ws.id, { ws, rt });
  renderWsBar();
  return rt;
}

// ===== 历史（按工作区划分）=====
async function openHistory() {
  historyPanel.classList.remove("hidden");
  historyListEl.innerHTML = "<div class='history-empty'>加载中…</div>";
  const list = await listSessions();
  historyListEl.innerHTML = "";
  if (!list.length) {
    historyListEl.innerHTML = "<div class='history-empty'>暂无历史会话</div>";
    return;
  }

  // 按工作区分组
  const groups = new Map();
  for (const s of list) {
    const key = s.workspaceId || "__none__";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(s);
  }

  for (const [wsId, sessions] of groups) {
    const head = document.createElement("div");
    head.className = "history-group";
    const wsEntry = workspaces.get(wsId);
    let label = "工作区";
    if (wsEntry) {
      const t = wsEntry.rt.targetPageLabel;
      label = t ? `工作区 · ${t}` : `工作区 · ${wsEntry.ws.tabIds.length} 个页面`;
    } else if (wsId === "__none__") {
      label = "未归属";
    } else {
      label = "工作区（已结束）";
    }
    head.textContent = label;
    historyListEl.appendChild(head);

    for (const s of sessions) {
      const item = document.createElement("div");
      item.className = "history-item";
      const title = document.createElement("div");
      title.className = "title";
      title.textContent = s.title || "（无标题）";
      item.appendChild(title);
      const sub = document.createElement("div");
      sub.className = "sub";
      const time = document.createElement("span");
      time.textContent = new Date(s.updatedAt).toLocaleString("zh-CN", {
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
      });
      sub.appendChild(time);
      const del = document.createElement("button");
      del.className = "del";
      del.textContent = "删除";
      del.addEventListener("click", async (e) => {
        e.stopPropagation();
        await deleteSession(s.id);
        openHistory();
      });
      sub.appendChild(del);
      item.appendChild(sub);
      item.addEventListener("click", () => {
        // 点历史会话 → 切到它所属的工作区并换上这份会话
        const entry = workspaces.get(wsId);
        if (entry) {
          entry.rt.session = s;
          entry.ws.sessionId = s.id;
          entry.rt.renderSession();
          persistAll();
          activateWorkspace(wsId);
        } else {
          // 工作区已结束：只读回看
          setStatus("该工作区已结束，只能查看", "");
        }
        historyPanel.classList.add("hidden");
      });
      historyListEl.appendChild(item);
    }
  }
}

// ===== 模型下拉 =====
function renderModelOptions() {
  modelSelect.innerHTML = "";
  for (const p of settings.providers) {
    for (const m of p.models || []) {
      const opt = document.createElement("option");
      opt.value = `${p.id}::${m.id}`;
      opt.textContent = `${p.name} / ${m.label || m.id}`;
      if (p.id === settings.activeProviderId && m.id === settings.activeModelId) {
        opt.selected = true;
      }
      modelSelect.appendChild(opt);
    }
  }
  if (modelSelect.options.length === 0) {
    const opt = document.createElement("option");
    opt.textContent = "未配置模型，请打开设置";
    opt.value = "";
    modelSelect.appendChild(opt);
  }
}

function syncShotToggle() {
  const [pid, mid] = modelSelect.value.split("::");
  const provider = findProvider(settings, pid);
  const model = (provider?.models || []).find((m) => m.id === mid);
  const vision = !!model?.vision;
  shotToggle.disabled = !vision;
  shotWrap.style.opacity = vision ? "1" : "0.45";
  shotWrap.title = vision
    ? "发送时截取一次当前屏幕（仅本条消息附带，不进历史、不重复截图）"
    : "当前模型不支持图片理解，无法附截图";
  if (!vision) shotToggle.checked = false;
}

function syncAutoToggle() {
  const on = ctlToggle.checked;
  autoToggle.disabled = !on;
  autoWrap.style.opacity = on ? "1" : "0.45";
  if (!on) autoToggle.checked = false;
}

function setStatus(text, kind) {
  statusEl.textContent = text || "";
  statusEl.className = "status" + (kind ? " " + kind : "");
}
