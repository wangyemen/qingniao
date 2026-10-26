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
  // ⚠️ 这个也要 import：监听 storage 变化时要用它拼出"本窗口的工作区键"
  //    （漏了它会在监听器里抛 ReferenceError → 后面的会话/横条/忙碌同步整段跑不到，
  //      表现为"横条不收、别的面板看不到更新"，测试抓到过）
  WORKSPACES_KEY,
  newWorkspace,
  loadSkills,
  loadMarketSettings,
} from "../lib/storage.js";
import { buildSkillPrompt } from "../lib/skills.js";
import {
  UPDATE_STATE_KEY,
  loadLocalVersionTxt,
  loadRemoteVersionTxt,
  changelogBetween,
  newerThan,
  parseVersionTxt,
} from "../lib/updates.js";
import { processFile, imagesFromClipboard } from "../lib/attach.js";
import { renderMarkdown } from "../lib/markdown.js";
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
const skillsBtn = document.getElementById("skillsBtn");
const skillPickerEl = document.getElementById("skillPicker");
const skillListEl = document.getElementById("skillList");
const skillMarketBtn = document.getElementById("skillMarketBtn");
const skillPickerCloseBtn = document.getElementById("skillPickerCloseBtn");
const skillRunBtn = document.getElementById("skillRunBtn");
const skillExtraEl = document.getElementById("skillExtra");
const inputMirror = document.getElementById("inputMirror");
const slashMenuEl = document.getElementById("slashMenu");
const updateModal = document.getElementById("updateModal");
const updateTitle = document.getElementById("updateTitle");
const updateSub = document.getElementById("updateSub");
const updateBody = document.getElementById("updateBody");
const updateSeenBtn = document.getElementById("updateSeenBtn");
const updateCloseBtn = document.getElementById("updateCloseBtn");
const updateRepoLink = document.getElementById("updateRepoLink");

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

// "没有工作区的页面"草稿的键：**按标签页分开**，不再共用一个槽
function pendingDraftKey(tabId) {
  return "t:" + (tabId != null ? tabId : "__none__");
}

// 一条消息真的发出去了 → 把对应草稿槽清掉。
// （以前只清输入框、草稿留着 ✗ → 之后任何一次视图激活都会把发过的内容塞回输入框，
//   用户看到"切换几个页面，刚才问的问题又出现了"，还容易误发重复消息。）
function clearDraftFor(tabId, wsId) {
  if (wsId) drafts.delete(wsId);
  if (tabId != null) drafts.delete(pendingDraftKey(tabId));
}

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
  // 开关状态：**以设置对象为准**（勾选框只是它的镜像）。
  // 以前读的是 DOM 勾选框 —— 在"每个标签页一份侧栏文档"的结构下，
  // 别的标签页改了设置，这份文档的勾选框可能还是旧值，会导致"开了自动执行还弹确认框"。
  toggleState: () => ({
    ctx: settings ? settings.contextEnabled !== false : ctxToggle.checked,
    ctl: settings ? settings.controlEnabled !== false : ctlToggle.checked,
    auto: settings ? !!settings.autoExecute : autoToggle.checked,
    shot: shotToggle.checked && !shotToggle.disabled,
    think: settings ? settings.thinkingEnabled !== false : thinkToggle.checked,
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
  // 工作区里的标签页变了（AI newtab / closetab）→ 刷新顶部的切换条
  renderWsBar: () => renderWsBar(),
  // 让运行时能主动"重读一遍工作区列表"（目标页一时读不到时用，避免误报"已关闭"）
  reloadWorkspaces: () => reloadWorkspaces(),
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
  bindConfirmDelegate(); // 执行/取消用事件委托，卡片重建后也点得动

  await restoreWorkspaces();
  await refreshActive();

  // 技能缓存 + 更新提醒（都不阻塞界面）
  refreshSkillsCache().catch(() => {});
  setTimeout(() => checkUpdates().catch(() => {}), 900);

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

  // 技能：点一下挑一个用；右键/长按直接开技能市场
  skillsBtn.addEventListener("click", () => toggleSkillPicker());
  skillsBtn.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    openSkillMarket();
  });
  skillPickerCloseBtn.addEventListener("click", () => skillPickerEl.classList.add("hidden"));
  skillMarketBtn.addEventListener("click", openSkillMarket);
  skillRunBtn.addEventListener("click", () => runSelectedSkill());

  // 更新弹窗
  updateSeenBtn.addEventListener("click", closeUpdateModal);
  updateCloseBtn.addEventListener("click", closeUpdateModal);
  updateModal.addEventListener("click", (e) => {
    if (e.target === updateModal) closeUpdateModal();
  });

  // 技能在别处被改动（设置页里装的/停用的）→ 本页缓存跟着更新
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes.ai_skills) {
      refreshSkillsCache().then(() => {
        if (!skillPickerEl.classList.contains("hidden")) renderSkillPicker();
      });
    }
  });

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
    // Tab：把正在输入的 /部分技能名 补全成完整技能
    if (e.key === "Tab" && !slashMenuEl.classList.contains("hidden")) {
      const first = slashMatches[0];
      if (first) {
        e.preventDefault();
        applySlashSuggestion(first);
        return;
      }
    }
    // Esc：收起技能提示
    if (e.key === "Escape" && !slashMenuEl.classList.contains("hidden")) {
      e.preventDefault();
      slashMenuEl.classList.add("hidden");
      return;
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      const rt = activeRuntime();
      if (!rt || !rt.busy) onSend();
    }
  });
  // 输入框内容按工作区暂存 + 实时刷新"/技能"高亮与补全
  // ⚠️ 没归属工作区的页面**按标签页分别暂存**（以前所有这种页面共用一个 "__pending__" 槽 ✗ ——
  //    在 A 页问过的问题，切到 B 页会原样冒出来，用户报过）。
  inputEl.addEventListener("input", () => {
    if (activeWsId) drafts.set(activeWsId, inputEl.value);
    else drafts.set(pendingDraftKey(pendingTabId), inputEl.value);
    autoGrowInput();
    updateInputHighlight();
    updateSlashMenu();
  });
  inputEl.addEventListener("blur", () => setTimeout(() => slashMenuEl.classList.add("hidden"), 150));
  inputEl.addEventListener("focus", () => {
    updateInputHighlight();
    updateSlashMenu();
  });
  // 镜像层与 textarea 必须完全重合：自动增高 + 滚动同步
  inputEl.addEventListener("scroll", () => {
    inputMirror.scrollTop = inputEl.scrollTop;
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

    // 另一份面板点了我这份实例里的"执行/取消" → 真正在跑的那份来落地这个决定
    // （侧栏每个标签页一份文档，卡片可能显示在非执行者那份里 ✗ 所以必须能跨实例回话）
    if (msg.type === "ws:confirm" && msg.wsId) {
      const rt = ownerOfWorkspace(msg.wsId);
      if (rt && typeof rt.pendingConfirm === "function") rt.pendingConfirm(msg.ok === true);
      return;
    }

    // 另一份面板把用户消息转交过来（它自己不是执行者）→ 接着跑
    if (msg.type === "ws:send" && msg.wsId && msg.text) {
      const rt = ownerOfWorkspace(msg.wsId);
      if (!rt) return;
      const payload = {
        text: msg.text,
        displayText: msg.displayText,
        attachments: msg.attachments || [],
      };
      if (rt.busy) rt.pendingSends.push(payload);
      else rt.send(payload).catch(() => {});
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
  //
  // ⚠️ 这里**必须也同步"设置"与"工作区列表"**：
  //    Chrome 的侧栏是"每个标签页一份文档"。用户在标签页 A 打开了「自动执行」、
  //    或 AI 在标签页 A 新开了一页 —— 标签页 B 的那份文档（它有自己的内存副本）如果不同步，
  //    就会：① 明明开了自动执行还弹确认框；② 切到 AI 新开的页却显示"新对话"；
  //    ③ 认为 AI 开的页"不在工作区/已关闭"。这三条都是用户实际报过的。
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;

    // 设置被改（在本实例或别的实例）→ 内存设置与界面勾选框都跟上
    if (changes["ai_browser_settings"]) {
      const fresh = changes["ai_browser_settings"].newValue;
      if (fresh) {
        settings = fresh;
        syncTogglesFromSettings();
      }
    }

    // 工作区列表被改（别的实例新建/并入/移出/关闭了标签页）→ 重读列表，再做"必要的"视图调整
    if (changes[WORKSPACES_KEY(windowId)] || changes["ai_workspaces"]) {
      resyncActiveView().catch(() => {});
    }

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
      const tasks = changes["ai_defer_tasks"].newValue || {};
      if (rt) {
        const id = rt.activeDeferTask && rt.activeDeferTask.id;
        if (id && !tasks[id]) rt.activeDeferTask = null;
        // ⚠️ 不管本地还记不记得这个任务，都按当前状态重画一次。
        //    以前只在"本地有记录且表里没有"时才收起 —— 本地记录一旦先丢，
        //    横条就永远挂在那儿（自愈失效，测试抓到过）。
        syncDeferChip(rt);
      } else {
        // 当前没有激活的工作区 → 横条不该继续挂在这里
        deferChip.classList.add("hidden");
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
      // AI 自己开的临时页（只有这些允许 closetab 关）：
      // **必须落盘** —— 侧栏每页一份文档，换个实例就不认识内存里的 Set 了，
      // 那会导致"AI 说自己开的页不是自己开的"或"找不到标签页"（用户报过）。
      aiTabs: Array.from(ws.aiTabs || []),
      sessionId: ws.sessionId,
      providerId: ws.providerId,
      modelId: ws.modelId,
      createdAt: ws.createdAt,
    });
  }
  saveWorkspaces(windowId, list).catch(() => {});
}

// 设置变了（别的标签页/设置页改的）→ 把四个勾选框拉回一致。
// 为什么必须有：侧栏是"每个标签页一份文档"，用户在 A 页勾上「自动执行」，
// B 页那份文档的勾选框还是旧值 → 明明开了自动，AI 在 B 页干活时照样弹确认框（用户报过）。
function syncTogglesFromSettings() {
  if (!settings) return;
  ctxToggle.checked = settings.contextEnabled !== false;
  thinkToggle.checked = settings.thinkingEnabled !== false;
  ctlToggle.checked = settings.controlEnabled !== false;
  autoToggle.checked = !!settings.autoExecute;
  syncShotToggle();
  syncAutoToggle();
}

// 重读工作区列表并**合并**进内存。
// ⚠️ 与 restoreWorkspaces 的区别：这里绝不重建已有工作区的 rt ——
//    那一轮可能正在跑，重建就把它的会话/忙碌状态丢了。只合并"成员变化"和"会话切换"。
async function reloadWorkspaces() {
  if (windowId == null) return;
  const { list } = await loadWorkspaces(windowId);
  if (!list.length) return;

  let tabs;
  try {
    tabs = await chrome.tabs.query({ windowId });
  } catch (_) {
    return;
  }
  if (!tabs.length) return;

  const aliveIds = new Set(tabs.map((t) => t.id));
  const sessions = await listSessions();
  let changed = false;

  for (const w of list) {
    const tabIds = (w.tabIds || []).filter((id) => aliveIds.has(id));
    if (!tabIds.length) continue;
    const rootTabId = tabIds.includes(w.rootTabId) ? w.rootTabId : tabIds[0];
    const entry = workspaces.get(w.id);

    if (entry) {
      const beforeKey = entry.ws.tabIds.join(",");
      entry.ws.tabIds = tabIds;
      entry.ws.rootTabId = rootTabId;
      if (Array.isArray(w.aiTabs)) entry.ws.aiTabs = w.aiTabs.slice();
      // 会话被切换（用户新建了对话 / 在别的实例里换了会话）→ 本实例跟着换并重绘
      if (entry.ws.sessionId !== w.sessionId) {
        const sess = sessions.find((s) => s.id === w.sessionId);
        if (sess) {
          entry.ws.sessionId = sess.id;
          sess.workspaceId = entry.ws.id;
          entry.rt.session = sess;
          if (!entry.rt.busy) entry.rt.renderSession();
        }
      }
      if (beforeKey !== tabIds.join(",")) changed = true;
    } else {
      const ws = { ...w, tabIds, rootTabId };
      let sess = sessions.find((s) => s.id === ws.sessionId);
      if (!sess) sess = newSession(ws.id);
      ws.sessionId = sess.id;
      sess.workspaceId = ws.id;
      const rt = new WorkspaceRuntime({ ws, session: sess, ctx: runtimeCtx });
      rt.renderSession();
      workspaces.set(ws.id, { ws, rt });
      changed = true;
    }
  }

  if (changed) {
    renderWsBar();
    const rt = activeRuntime();
    if (rt) syncHeader(rt);
  }
}

// ===== 确认卡片的"执行 / 取消"：事件委托 =====
//
// 为什么用委托而不是给按钮挂监听器：侧栏会在切换标签页、同步会话等时机
// **重建整份消息列表**（renderSession），卡片是新建出来的，旧监听器随之消失 ——
// 于是出现"执行/取消 还显示着、点了却没反应"（用户实际报过）。
// 委托挂在 document 上，卡片无论怎么重建都点得到。
function bindConfirmDelegate() {
  document.addEventListener(
    "click",
    (ev) => {
      const btn = ev.target && ev.target.closest ? ev.target.closest(".ok-btn, .cancel-btn") : null;
      if (!btn) return;
      const card = btn.closest(".tool-card");
      if (!card || !card.classList.contains("pending")) return;
      const wsId = card.dataset.wsId || activeWsId;
      const entry = workspaces.get(wsId);
      const rt = entry && entry.rt;
      if (!rt || typeof rt.pendingConfirm !== "function") {
        // 这一份实例不是执行者（卡片显示在这里、真正在跑的是另一份侧栏文档）→
        // 广播出去，让在跑的那份落地这个决定（否则就是"点了没反应"）
        if (wsId) {
          try {
            chrome.runtime.sendMessage({ type: "ws:confirm", wsId, ok: btn.classList.contains("ok-btn") }).catch(() => {});
          } catch (_) {}
        }
        // 视觉上也给点反馈，别让人以为没点到
        card.classList.remove("pending");
        card.classList.add(btn.classList.contains("ok-btn") ? "running" : "cancelled");
        const acts = card.querySelector(".tool-actions");
        if (acts) acts.innerHTML = "<span class='tool-detail'>" + (btn.classList.contains("ok-btn") ? "执行中…（交给正在运行的那份面板）" : "已取消") + "</span>";
        ev.preventDefault();
        ev.stopPropagation();
        return;
      }
      ev.preventDefault();
      ev.stopPropagation();
      const ok = btn.classList.contains("ok-btn");
      const finish = rt.pendingConfirm;
      // 立刻给视觉反馈（不然用户会以为没点到，反复点）
      card.classList.remove("pending");
      card.classList.add(ok ? "running" : "cancelled");
      const actions = card.querySelector(".tool-actions");
      const res = card.querySelector(".tool-result");
      if (actions) actions.innerHTML = ok ? "<span class='tool-detail'>执行中…</span>" : "<span class='tool-detail'>已取消</span>";
      if (!ok && res) {
        res.hidden = false;
        res.textContent = "已取消：你取消了这一步";
      }
      finish(ok);
    },
    true // capture：抢在卡片自身（如果有）之前处理，且不受冒泡被挡影响
  );
}

// 工作区列表被别处改了 → 重读列表，并**只做必要**的视图调整。
//
// ⚠️ 千万别在这里直接调 refreshActive()：那会按"当前活动标签页"重算视图，
//    而这个面板自己也是个标签页 —— 一旦它此刻不是活动页，就会把正在显示的
//    工作区视图拆成"空对话"（后台任务横条、正在看的会话一起没，测试抓到过）。
//    这里只处理一件事：**当前这一页现在有主了**（比如 AI 刚把它并进来）→ 切过去。
async function resyncActiveView() {
  await reloadWorkspaces();
  const cur = await activeTab();
  const tabId = cur?.id ?? null;
  const ws = wsOfTab(tabId);
  if (ws) {
    pendingTabId = tabId;
    if (activeWsId !== ws.id) {
      activateWorkspace(ws.id);
      await refreshCtxInfo();
    } else {
      const rt = workspaces.get(ws.id)?.rt;
      if (rt) syncHeader(rt);
    }
    return;
  }
  if (activeWsId == null && tabId != null) {
    pendingTabId = tabId;
    activatePending(tabId, cur);
  }
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
      <div class="ver-note">v${APP_VERSION}</div>
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
  inputEl.value = drafts.get(pendingDraftKey(tabId)) || "";
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
  // 自动化任务用"运行中"的说法，普通后台任务用"等待…满足后自动继续"
  const isAuto = task.until && task.until.type === "automation";
  deferChipText.textContent = isAuto
    ? `🧩 ${rt.deferLabel(task)}`
    : `后台任务：${rt.deferLabel(task)}，满足后自动继续`;
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
  // 命中 "/技能" → 换成带技能说明书的正式请求（显示上仍只写"使用了哪个技能"）
  const asSkill = extractSkillSend(text);
  const sendText = asSkill ? asSkill.prompt : text;
  const displayText = asSkill ? asSkill.displayText : undefined;
  slashMenuEl.classList.add("hidden");
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
    // ⚠️ 顺序很关键：**先在"还没有工作区"的时候把草稿附件拿到手**，
    //    再去建工作区。以前是先建工作区、再 currentAttachments() ✗ ——
    //    那时 activeRuntime() 已经指向新工作区了，于是拿到的是**空的**新列表 ✗，
    //    结果"在没有工作区的页面上贴的图"永远进不了消息（用户看不到自己附的截图就是这个原因）。
    const draftAtts = currentAttachments().slice();
    const newRt = createWorkspaceForTab(cur.id, cur);
    newRt.attachments = draftAtts;
    pendingAttachments = [];
    inputEl.value = "";
    updateInputHighlight();
    // 草稿槽也一起清（否则切页又会把这条塞回输入框）
    clearDraftFor(cur.id, newRt.ws.id);
    const atts = newRt.attachments.slice();
    newRt.attachments = [];
    renderAttachments(newRt);
    try {
      await newRt.send({ text: sendText, displayText, attachments: atts });
    } catch (err) {
      // 发失败就把文字放回输入框，别让用户白打一遍
      inputEl.value = text;
      updateInputHighlight();
      setStatus("发送失败，文字已放回输入框：" + ((err && err.message) || err), "err");
      drafts.set(newRt.ws.id, text);
    }
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
    updateInputHighlight();
    clearDraftFor(curTabId, rt.ws.id);
    try {
      chrome.runtime.sendMessage({
        type: "ws:send",
        wsId: rt.ws.id,
        text: sendText,
        displayText,
        attachments: atts,
      }).catch(() => {});
    } catch (_) {}
    setStatus("已把这条消息交给正在运行的那份面板", "ok");
    return;
  }

  inputEl.value = "";
  updateInputHighlight();
  clearDraftFor(curTabId, rt.ws.id);
  const atts = rt.attachments.slice();
  rt.attachments = [];
  renderAttachments(rt);
  try {
    await rt.send({ text: sendText, displayText, attachments: atts });
  } catch (err) {
    inputEl.value = text;
    updateInputHighlight();
    drafts.set(rt.ws.id, text);
    setStatus("发送失败，文字已放回输入框：" + ((err && err.message) || err), "err");
  }
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

// 版本号：显示在界面上，方便确认"当前跑的是不是最新构建"
const APP_VERSION = (() => {
  try {
    return chrome.runtime.getManifest().version;
  } catch (_) {
    return "";
  }
})();

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

// ===== 「/」调用技能 =====
//
// 用户可以在输入框里直接打 /技能名（如 /page-summary 或 /页面摘要），
// 命中已启用的技能时：① 整段变成高亮色，让你一眼看出"用上了"；
//                    ② 发送时自动换成"带技能说明书"的正式请求。
// 没命中就只是普通文字（保持原样，不变色）。

// 找出文本里第一个命中的 "/技能"，返回 { skill, start, end, rest }
function findSkillToken(text) {
  const s = String(text || "");
  const re = /\/([A-Za-z0-9_\-\u4e00-\u9fa5]+)/g;
  let m;
  while ((m = re.exec(s))) {
    const token = m[1];
    const lower = token.toLowerCase();
    const skill = enabledSkills().find(
      (k) => k.id.toLowerCase() === lower || String(k.title || "").toLowerCase() === lower
    );
    if (skill) {
      const rest = (s.slice(0, m.index) + " " + s.slice(m.index + m[0].length)).trim();
      return { skill, token, start: m.index, end: m.index + m[0].length, rest };
    }
  }
  return null;
}

// 正在输入中的"/前缀"（用于补全菜单）：取光标所在的那个词
function currentSlashQuery() {
  const s = inputEl.value;
  const upto = s.slice(0, inputEl.selectionStart == null ? s.length : inputEl.selectionStart);
  const m = /(?:^|\s)\/([A-Za-z0-9_\-\u4e00-\u9fa5]*)$/.exec(upto);
  return m ? { query: m[1], at: m.index + m[0].indexOf("/") } : null;
}

function updateInputHighlight() {
  const wrap = inputEl.parentElement;
  const hit = findSkillToken(inputEl.value);
  if (!hit) {
    // 没命中：完全走原生 textarea（不换色、不套镜像层，避免任何对齐问题）
    wrap.classList.remove("mirroring");
    inputMirror.textContent = "";
    return;
  }
  // 命中：用镜像层渲染（textarea 文字透明，只留光标），把命中的技能染成主色
  const v = inputEl.value;
  const before = escapeHtml(v.slice(0, hit.start));
  const token = escapeHtml(v.slice(hit.start, hit.end));
  const after = escapeHtml(v.slice(hit.end));
  inputMirror.innerHTML =
    before + `<span class="skill-token">${token}</span>` + after + "\n";
  wrap.classList.add("mirroring");
}

function escapeHtml(s) {
  return String(s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

let slashMatches = [];

function updateSlashMenu() {
  const cur = currentSlashQuery();
  if (!cur) {
    slashMenuEl.classList.add("hidden");
    slashMatches = [];
    return;
  }
  const q = cur.query.toLowerCase();
  const list = enabledSkills().filter((s) => {
    if (!q) return true;
    return (
      s.id.toLowerCase().includes(q) ||
      String(s.title || "").toLowerCase().includes(q) ||
      String(s.description || "").toLowerCase().includes(q)
    );
  });
  slashMatches = list.slice(0, 8);
  if (!slashMatches.length) {
    slashMenuEl.classList.add("hidden");
    return;
  }
  slashMenuEl.innerHTML = "";
  const head = document.createElement("div");
  head.className = "slash-head";
  head.textContent = q ? `技能匹配「${cur.query}」` : "输入技能名，Tab 补全";
  slashMenuEl.appendChild(head);
  for (const s of slashMatches) {
    const item = document.createElement("button");
    item.type = "button";
    item.className = "slash-item";
    item.innerHTML =
      `<span class="slash-id">/${escapeHtml(s.id)}</span>` +
      `<span class="slash-title">${escapeHtml(s.title || "")}</span>`;
    item.addEventListener("mousedown", (e) => {
      e.preventDefault();
      applySlashSuggestion(s);
    });
    slashMenuEl.appendChild(item);
  }
  slashMenuEl.classList.remove("hidden");
}

// 把当前正在输入的 /前缀 替换成完整技能名
function applySlashSuggestion(skill) {
  const cur = currentSlashQuery();
  const v = inputEl.value;
  if (cur) {
    const before = v.slice(0, cur.at);
    const after = v.slice(inputEl.selectionStart == null ? v.length : inputEl.selectionStart);
    inputEl.value = before + "/" + skill.id + " " + after.replace(/^\s*/, "");
  } else {
    inputEl.value = v + (v && !/\s$/.test(v) ? " " : "") + "/" + skill.id + " ";
  }
  slashMenuEl.classList.add("hidden");
  updateInputHighlight();
  inputEl.focus();
  const pos = inputEl.value.length;
  try {
    inputEl.setSelectionRange(pos, pos);
  } catch (_) {}
}

// 发送时：如果消息里有 "/技能"，换成正式请求
function extractSkillSend(text) {
  const hit = findSkillToken(text);
  if (!hit) return null;
  return {
    skill: hit.skill,
    prompt: buildSkillPrompt(hit.skill, hit.rest),
    displayText: `🧩 使用技能：${hit.skill.title || hit.skill.id}${hit.rest ? "（" + hit.rest + "）" : ""}`,
  };
}

// 输入框自动增高（最多占到面板高度的 40%）。
// 为什么要它：镜像层与 textarea 用同一个盒子，只有**不内部滚动**时两者才严格重合；
// 超过上限后由下面 scroll 事件把镜像层的滚动位置同步过去。
function autoGrowInput() {
  try {
    inputEl.style.height = "auto";
    const max = Math.max(60, Math.round(window.innerHeight * 0.4));
    const h = Math.min(inputEl.scrollHeight, max);
    inputEl.style.height = h + "px";
    inputMirror.scrollTop = inputEl.scrollTop;
  } catch (_) {}
}

function setStatus(text, kind) {
  statusEl.textContent = text || "";
  statusEl.className = "status" + (kind ? " " + kind : "");
}

// ===== 技能 =====
//
// 技能 = 一份写给 AI 看的 Markdown 说明书。数据存在 chrome.storage.local（ai_skills），
// 技能市场页面（skills/index.html）负责安装与编辑；这里只负责"挑一个用"。

let skillsCache = {};
let pickedSkillId = null;

async function refreshSkillsCache() {
  try {
    skillsCache = await loadSkills();
  } catch (_) {
    skillsCache = {};
  }
  return skillsCache;
}

function enabledSkills() {
  return Object.values(skillsCache)
    .filter((s) => s && s.enabled !== false && (s.body || "").trim())
    .sort((a, b) => (a.title || a.id).localeCompare(b.title || b.id, "zh"));
}

function toggleSkillPicker() {
  const hidden = skillPickerEl.classList.contains("hidden");
  if (!hidden) {
    skillPickerEl.classList.add("hidden");
    return;
  }
  historyPanel.classList.add("hidden");
  renderSkillPicker();
  skillPickerEl.classList.remove("hidden");
  skillExtraEl.focus();
}

function renderSkillPicker() {
  skillListEl.innerHTML = "";
  const list = enabledSkills();
  if (!list.length) {
    const empty = document.createElement("div");
    empty.className = "skill-empty";
    empty.innerHTML =
      "还没有装技能。<br/>去「技能市场」挑几个，或自己写一个 —— 技能就是一份让 AI 照做的说明书。";
    skillListEl.appendChild(empty);
    skillRunBtn.disabled = true;
    return;
  }
  skillRunBtn.disabled = false;
  if (!pickedSkillId || !list.some((s) => s.id === pickedSkillId)) pickedSkillId = list[0].id;
  for (const s of list) {
    const item = document.createElement("button");
    item.className = "skill-item" + (s.id === pickedSkillId ? " active" : "");
    item.type = "button";
    const icon = document.createElement("span");
    icon.className = "skill-item-icon";
    icon.textContent = s.icon || "🧩";
    const text = document.createElement("span");
    text.className = "skill-item-text";
    const title = document.createElement("b");
    title.textContent = s.title || s.id;
    const desc = document.createElement("small");
    desc.textContent = s.description || "（没有说明）";
    text.appendChild(title);
    text.appendChild(desc);
    const ver = document.createElement("span");
    ver.className = "skill-item-ver";
    ver.textContent = "v" + (s.version || "?");
    item.appendChild(icon);
    item.appendChild(text);
    item.appendChild(ver);
    item.addEventListener("click", () => {
      pickedSkillId = s.id;
      renderSkillPicker();
    });
    skillListEl.appendChild(item);
  }
}

async function runSelectedSkill() {
  await refreshSkillsCache();
  const skill = skillsCache[pickedSkillId];
  if (!skill) {
    setStatus("没有选中的技能", "err");
    return;
  }
  const rt = activeRuntime();
  if (!rt) {
    // 当前页还没建工作区：先建（跟发第一条消息一样的懒创建）
    const cur = pendingTabId != null ? { id: pendingTabId } : await activeTab();
    if (!cur || cur.id == null) {
      setStatus("找不到当前标签页", "err");
      return;
    }
    const newRt = createWorkspaceForTab(cur.id, cur);
    skillPickerEl.classList.add("hidden");
    const prompt = buildSkillPrompt(skill, skillExtraEl.value);
    skillExtraEl.value = "";
    await newRt.send({ text: prompt, displayText: `🧩 使用技能：${skill.title || skill.id}` });
    return;
  }
  if (rt.busy) {
    setStatus("正在跑着，等这一轮结束再用技能", "err");
    return;
  }
  const prompt = buildSkillPrompt(skill, skillExtraEl.value);
  const extra = skillExtraEl.value.trim();
  skillExtraEl.value = "";
  skillPickerEl.classList.add("hidden");
  // displayText：气泡里只显示"用了哪个技能"，不把整份说明书糊在界面上
  await rt.send({
    text: prompt,
    displayText: `🧩 使用技能：${skill.title || skill.id}${extra ? "（" + extra + "）" : ""}`,
  });
}

function openSkillMarket() {
  // 技能市场就在设置页里（那一页地方大，好浏览好编辑），直接跳到技能标签
  const url = chrome.runtime.getURL("options/index.html") + "#skills";
  try {
    chrome.tabs.create({ url });
  } catch (_) {
    try {
      chrome.runtime.openOptionsPage();
    } catch (__) {}
  }
  skillPickerEl.classList.add("hidden");
}

// ===== 更新提醒 =====

const UPDATE_CHECK_GAP = 6 * 60 * 60 * 1000; // 联网检查最多 6 小时一次
const REPO_URL = "https://github.com/wangyemen/qingniao";

function renderChangelog(entries) {
  if (!entries || !entries.length) return "";
  const parts = [];
  for (const e of entries) {
    parts.push(`### ${e.version}`);
    for (const line of e.lines || []) parts.push(line);
  }
  return parts.join("\n");
}

function showUpdateModal({ title, sub, changelogMd, repoUrl }) {
  updateTitle.textContent = title || "青鸟已更新";
  updateSub.textContent = sub || "";
  const md = changelogMd || "";
  updateBody.innerHTML = md
    ? renderMarkdown(md)
    : '<p class="muted">（这一版没有单独的更新说明）</p>';
  updateRepoLink.href = repoUrl || REPO_URL;
  updateModal.classList.remove("hidden");
}

async function checkUpdates() {
  let state = {};
  try {
    const got = await chrome.storage.local.get(UPDATE_STATE_KEY);
    state = got[UPDATE_STATE_KEY] || {};
  } catch (_) {}

  const local = await loadLocalVersionTxt();
  const seen = state.seenVersion;

  // ① 本机刚更新过（上次看到的是更旧的版本）→ 弹更新日志
  if (local && seen && seen !== APP_VERSION) {
    const entries = changelogBetween(local, seen, APP_VERSION);
    showUpdateModal({
      title: `青鸟已更新到 v${APP_VERSION}`,
      sub: `上次是 v${seen}${local.released ? " · " + local.released : ""}`,
      changelogMd: renderChangelog(entries),
      repoUrl: local.repo || REPO_URL,
    });
    try {
      await chrome.action.setBadgeText({ text: "新" });
      await chrome.action.setBadgeBackgroundColor({ color: "#14b8a6" });
    } catch (_) {}
    return; // 等用户看完再管"线上有没有更新"
  }

  // ② 首次安装：记下来，不打扰
  if (!seen) {
    try {
      await chrome.storage.local.set({
        [UPDATE_STATE_KEY]: { ...state, seenVersion: APP_VERSION, installedAt: Date.now() },
      });
    } catch (_) {}
  }

  // ③ 联网看仓库里有没有更新的版本（有节流；失败静默）
  const lastCheck = state.checkedAt || 0;
  if (Date.now() - lastCheck < UPDATE_CHECK_GAP) return;
  try {
    await chrome.storage.local.set({ [UPDATE_STATE_KEY]: { ...state, checkedAt: Date.now() } });
  } catch (_) {}
  const remote = await loadRemoteVersionTxt();
  if (!remote) return;
  const newer = newerThan(remote, APP_VERSION);
  if (!newer) return;
  const entries = changelogBetween(remote, APP_VERSION, newer);
  showUpdateModal({
    title: `有新版本 v${newer} 可用`,
    sub: `你当前是 v${APP_VERSION} · 去仓库更新即可（解压覆盖后重新加载扩展）`,
    changelogMd: renderChangelog(entries),
    repoUrl: remote.repo || REPO_URL,
  });
  try {
    await chrome.action.setBadgeText({ text: "新" });
    await chrome.action.setBadgeBackgroundColor({ color: "#f59e0b" });
  } catch (_) {}
}

function closeUpdateModal() {
  updateModal.classList.add("hidden");
  try {
    chrome.storage.local.get(UPDATE_STATE_KEY).then((got) => {
      const state = got[UPDATE_STATE_KEY] || {};
      return chrome.storage.local.set({
        [UPDATE_STATE_KEY]: { ...state, seenVersion: APP_VERSION },
      });
    });
    chrome.action.setBadgeText({ text: "" });
  } catch (_) {}
  // 关闭后再看看线上有没有新版本
  setTimeout(() => checkUpdates().catch(() => {}), 600);
}
