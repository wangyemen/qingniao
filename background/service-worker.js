// Service Worker：侧边栏行为 + 多工作区管理
//
// 工作区模型（用户明确要求，0.5.0 起）：
//   一个窗口可以有**多个**工作区，每个工作区 = 一组 AI 正在控制的标签页。
//   ① 用户在某标签页第一次发消息 → 为它建一个工作区。
//   ② AI 在工作区里自己开的新标签页 → 并入该工作区。
//   ③ 用户切到不属于任何工作区的标签页 → 侧栏显示这个页面的空对话，
//      首次发消息时再建工作区。**不再有"这里不能用 AI"的占位页。**
//   ④ 工作区之间硬隔离：互相看不到、读不到、不能互相操作。
//   ⑤ 工作区内的标签页全关 → 工作区消失，其会话一并删除。
//
// ⚠️ 关键设计约束（0.3.1 修的"侧边栏点不开"事故，必须守住）：
//   绝不用 chrome.sidePanel.setOptions({enabled:false}) 隐藏面板 ——
//   那会让扩展图标变成死按钮，界面上没有任何恢复入口。
//   现在所有标签页的面板 path 恒为正常对话页，enabled 恒为 true。
//
// 之前踩过的坑（不要再犯）：
//   · 作用域存 sessionStorage、SW 读 storage.local → 两边不共享 → 死锁。
//     现在唯一真相是 chrome.storage.local 的 ai_workspaces_<windowId>。
//   · chrome.sidePanel.open() 必须在用户手势里同步调用 → 不用它，交给 Chrome 原生行为。
//   · chrome.runtime.onMessage 监听器不能是 async（消息通道会提前关）。

const MAIN_PANEL = "sidepanel/index.html";
const IDLE_PANEL = "sidepanel/inactive.html";

// Chrome 原生行为：点扩展图标就开关面板。这是最可靠的路径 ——
// 不依赖任何手势、不依赖 setOptions、不会锁死。
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch((err) => {
  console.error("sidePanel behavior error:", err);
});

// ===== 多工作区注册表 =====
// 唯一真相：chrome.storage.local 的 ai_workspaces_<windowId> = { list: [ws...] }
// ws = { id, rootTabId, tabIds:[], sessionId, providerId, modelId, createdAt }
const WORKSPACES_KEY = (windowId) => `ai_workspaces_${windowId == null ? "cur" : windowId}`;

async function loadWorkspaces(windowId) {
  try {
    const key = WORKSPACES_KEY(windowId);
    const got = await chrome.storage.local.get(key);
    const raw = got && got[key];
    if (!raw || !Array.isArray(raw.list)) return [];
    return raw.list.filter((w) => w && w.id && Array.isArray(w.tabIds) && w.tabIds.length);
  } catch (_) {
    return [];
  }
}

async function saveWorkspaces(windowId, list) {
  try {
    const key = WORKSPACES_KEY(windowId);
    if (!list || !list.length) {
      await chrome.storage.local.remove(key);
      return;
    }
    await chrome.storage.local.set({ [key]: { list } });
  } catch (_) {}
}

// 会话 key（和 sidepanel/lib/storage.js 保持一致）
const SESSIONS_KEY = "ai_browser_sessions";

// 工作区消失了 → 把它名下的会话一起删掉（用户明确要求）
async function deleteSessionsOfWorkspace(workspaceId) {
  if (!workspaceId) return;
  try {
    const got = await chrome.storage.local.get(SESSIONS_KEY);
    const list = got[SESSIONS_KEY] || [];
    const kept = list.filter((s) => s.workspaceId !== workspaceId);
    if (kept.length !== list.length) {
      await chrome.storage.local.set({ [SESSIONS_KEY]: kept });
    }
  } catch (_) {}
}

// ===== 后台任务（defer）：条件触发的"等待-唤醒-继续" =====
//
// 用户需求：比如"等这个视频播完，帮我点下一节"。API 请求有超时（60 秒级），
// 不能让一轮对话干等几十分钟 —— 正确做法是挂起本轮，注册一个后台任务，
// 条件满足时由页面事件 / chrome.alarms 唤醒，自动续跑指令。
//
// 任务状态存 chrome.storage.local（SW 会休眠，内存不算数），
// chrome.alarms 做兜底超时（页面被关/事件丢失时也能唤醒收尾）。
//
// 生命周期：
//   sidepanel "defer:register" → 存任务 + 建 alarm
//   content "defer:fired"      → 条件满足 → 通知侧栏唤醒（存 pending wake）
//   alarms 超时                → 同上，reason 标"超时"
//   sidepanel "defer:cancel"   → 删任务 + 清 alarm + 让页面拆监听

const DEFER_TASKS_KEY = "ai_defer_tasks";
const DEFER_WAKE_KEY = "ai_defer_pending_wake";
const DEFER_WAKE_TTL = 10 * 60 * 1000; // 唤醒事件保留 10 分钟（侧栏没开就过期作废）

async function loadDeferTasks() {
  try {
    const got = await chrome.storage.local.get(DEFER_TASKS_KEY);
    return got[DEFER_TASKS_KEY] || {};
  } catch (_) {
    return {};
  }
}

async function saveDeferTasks(tasks) {
  try {
    await chrome.storage.local.set({ [DEFER_TASKS_KEY]: tasks });
  } catch (_) {}
}

function deferAlarmName(taskId) {
  return "defer:" + taskId;
}

// 唤醒：写入 pending wake（侧栏打开时立即消费；没开就等下次打开时续跑）
async function wakeDeferTask(task, reason) {
  const wake = {
    taskId: task.id,
    reason: reason || "条件已满足",
    instruction: task.instruction || "",
    until: task.until || null,
    tabId: task.tabId,
    windowId: task.windowId,
    workspaceId: task.workspaceId || null, // 唤醒要路由回它自己那一份工作区
    at: Date.now(),
  };
  try {
    await chrome.storage.local.set({ [DEFER_WAKE_KEY]: wake });
  } catch (_) {}
  // 侧栏在线的话立刻收到（没有接收方会抛，忽略即可）
  try {
    const p = chrome.runtime.sendMessage({ type: "defer:wake", wake });
    if (p && p.catch) p.catch(() => {});
  } catch (_) {}
  return wake;
}

async function finishDeferTask(taskId, reason, opts = {}) {
  const tasks = await loadDeferTasks();
  const task = tasks[taskId];
  if (!task) return null;
  delete tasks[taskId];
  await saveDeferTasks(tasks);
  try {
    await chrome.alarms.clear(deferAlarmName(taskId));
  } catch (_) {}
  // 让页面把监听拆掉（页面可能已关，失败无所谓）
  try {
    if (task.tabId != null) {
      const p = chrome.tabs.sendMessage(task.tabId, { type: "defer:cancel", taskId });
      if (p && p.catch) p.catch(() => {});
    }
  } catch (_) {}
  // 用户主动取消：只收尾，不唤醒续跑
  if (opts.noWake) return null;
  return wakeDeferTask(task, reason);
}

// 超时兜底：页面事件丢了（页面关了/被导航走）时，alarm 会把任务收尾唤醒
chrome.alarms.onAlarm.addListener((alarm) => {
  if (!alarm || !alarm.name || !alarm.name.startsWith("defer:")) return;
  const taskId = alarm.name.slice("defer:".length);
  (async () => {
    await finishDeferTask(taskId, "等待超时（兜底定时器触发，条件可能未达成）");
  })();
});

// 侧栏发来的后台任务消息
// 注意：监听器不能是 async（消息通道会提前关），异步逻辑放 IIFE。
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg !== "object") return;

  if (msg.type === "defer:register") {
    const task = msg.task || {};
    if (!task.id) {
      sendResponse({ ok: false, msg: "任务缺少 id" });
      return true;
    }
    (async () => {
      const tasks = await loadDeferTasks();
      const timeoutSec = Math.min(86400, Math.max(10, Number(task.timeoutSec) || 1800));
      tasks[task.id] = {
        id: task.id,
        instruction: String(task.instruction || "").slice(0, 2000),
        until: task.until || null,
        tabId: task.tabId != null ? task.tabId : null,
        windowId: task.windowId != null ? task.windowId : null,
        workspaceId: task.workspaceId || null,
        timeoutSec,
        createdAt: Date.now(),
      };
      await saveDeferTasks(tasks);
      try {
        await chrome.alarms.create(deferAlarmName(task.id), { delayInMinutes: timeoutSec / 60 });
      } catch (_) {}
      sendResponse({ ok: true, timeoutSec });
    })();
    return true;
  }

  if (msg.type === "defer:fired") {
    // 页面条件满足了（video ended / 文字出现等）
    (async () => {
      await finishDeferTask(msg.taskId, msg.reason || "条件已满足");
      sendResponse({ ok: true });
    })();
    return true;
  }

  if (msg.type === "defer:cancel") {
    (async () => {
      // 取消只收尾不唤醒（否则用户点取消反而触发续跑）
      await finishDeferTask(msg.taskId, "用户取消了后台任务", { noWake: true });
      try {
        await chrome.storage.local.remove(DEFER_WAKE_KEY);
      } catch (_) {}
      sendResponse({ ok: true });
    })();
    return true;
  }

  if (msg.type === "defer:ack") {
    // 侧栏说：这个唤醒我已经接过来跑了 → 清掉"待消费"记录。
    // 不清的话，下次侧栏初始化时 defer:consume 会把它再交出去，同一个唤醒跑两遍
    // （请求翻倍 → 429 限流）。
    (async () => {
      try {
        const got = await chrome.storage.local.get(DEFER_WAKE_KEY);
        const wake = got && got[DEFER_WAKE_KEY];
        if (!wake) {
          sendResponse({ ok: true });
          return;
        }
        if (!msg.taskId || wake.taskId === msg.taskId) {
          await chrome.storage.local.remove(DEFER_WAKE_KEY);
        }
      } catch (_) {}
      sendResponse({ ok: true });
    })();
    return true;
  }

  if (msg.type === "defer:consume") {
    // 侧栏说：我准备好续跑了，把 pending wake 给我
    (async () => {
      try {
        const got = await chrome.storage.local.get(DEFER_WAKE_KEY);
        const wake = got[DEFER_WAKE_KEY];
        if (wake && Date.now() - (wake.at || 0) < DEFER_WAKE_TTL) {
          await chrome.storage.local.remove(DEFER_WAKE_KEY);
          sendResponse({ ok: true, wake });
        } else {
          if (wake) await chrome.storage.local.remove(DEFER_WAKE_KEY);
          sendResponse({ ok: true, wake: null });
        }
      } catch (_) {
        sendResponse({ ok: true, wake: null });
      }
    })();
    return true;
  }

  if (msg.type === "defer:list") {
    (async () => {
      const tasks = await loadDeferTasks();
      sendResponse({ ok: true, tasks: Object.values(tasks) });
    })();
    return true;
  }

  // 侧栏问：某个标签页属于哪个工作区（隔离校验用）
  if (msg.type === "ws:of") {
    (async () => {
      const list = await loadWorkspaces(msg.windowId);
      const hit = list.find((w) => (w.tabIds || []).includes(msg.tabId));
      sendResponse({ ok: true, workspaceId: hit ? hit.id : null });
    })();
    return true;
  }

  // 侧栏说"工作区列表变了" → 立刻重新同步面板状态
  if (msg.type === "ws:sync") {
    const winId = msg.windowId;
    if (winId != null) syncPanelEnabled(winId);
    sendResponse({ ok: true });
    return true;
  }
});

// 面板同步：**只做清理，不再主动碰面板配置**。
//
// 0.5.0 起不再有"区外占位页"：任何标签页都能用 AI，只是各自归到自己的工作区。
// 既然所有标签页的 path 完全一样，就**根本不需要逐个 setOptions** ——
// manifest 的 side_panel.default_path 已经保证每个标签页都能开面板。
//
// ⚠️ 为什么不再逐个 setOptions（重要，别再改回去）：
//    以前每次标签页激活/新建/关闭都对**窗口内所有标签页**重设一遍 options，
//    用户把这当成了"我把某个标签页的侧栏关掉，切回来它又自动出现"。
//    我们不再主动碰面板配置，Chrome 自己的开/关状态才立得住。
//
// 这里只做"清理"：剔掉已关闭的标签页；工作区空了就连同会话一起删。
async function syncPanelEnabled(windowId) {
  try {
    const tabs = await chrome.tabs.query({ windowId });
    if (!tabs.length) return;
    const aliveIds = new Set(tabs.map((t) => t.id));

    const list = await loadWorkspaces(windowId);
    const kept = [];
    let changed = false;
    for (const w of list) {
      const tabIds = (w.tabIds || []).filter((id) => aliveIds.has(id));
      if (!tabIds.length) {
        // 工作区里的标签页全关 → 工作区消失，会话一并删除（用户明确要求）
        await deleteSessionsOfWorkspace(w.id);
        changed = true;
        continue;
      }
      const rootTabId = tabIds.includes(w.rootTabId) ? w.rootTabId : tabIds[0];
      if (tabIds.length !== (w.tabIds || []).length || rootTabId !== w.rootTabId) changed = true;
      kept.push({ ...w, tabIds, rootTabId });
    }
    if (changed) await saveWorkspaces(windowId, kept);
  } catch (_) {}
}

// 标签页切换 → 只做清理（面板配置不再动）
chrome.tabs.onActivated.addListener(async ({ windowId }) => {
  await syncPanelEnabled(windowId);
});

// 标签页被"替换"（浏览器预渲染 / Instant 导航）：视觉上无感，但 tabId 变了。
// 必须把持久化的工作区里的旧 id 换成新 id —— 否则侧栏一刷新就恢复不出那份工作区
//（用户反馈："点视频链接就回到新对话页面"）。
chrome.tabs.onReplaced.addListener(async (addedTabId, removedTabId) => {
  try {
    const t = await chrome.tabs.get(addedTabId);
    if (!t || t.windowId == null) return;
    const list = await loadWorkspaces(t.windowId);
    let changed = false;
    for (const w of list) {
      const i = (w.tabIds || []).indexOf(removedTabId);
      if (i < 0) continue;
      w.tabIds[i] = addedTabId;
      w.tabIds = [...new Set(w.tabIds)];
      if (w.rootTabId === removedTabId) w.rootTabId = addedTabId;
      changed = true;
    }
    if (changed) await saveWorkspaces(t.windowId, list);
    await syncPanelEnabled(t.windowId);
  } catch (_) {}
});

// 标签页被关 → 从它所属的工作区移除；该工作区空了 → 整份消失 + 删会话
chrome.tabs.onRemoved.addListener(async (tabId, { windowId }) => {
  await syncPanelEnabled(windowId);
});

// 新标签页：不属于任何工作区（AI 开的会由侧栏显式并入）
chrome.tabs.onCreated.addListener(async (tab) => {
  if (tab.windowId != null) await syncPanelEnabled(tab.windowId);
});

// 恢复工作区（service worker 可能被休眠重启）
chrome.runtime.onStartup.addListener(async () => {
  try {
    const wins = await chrome.windows.getAll();
    for (const w of wins) await syncPanelEnabled(w.id);
  } catch (_) {}
});

// 扩展加载/更新后：**一次性**清掉上一版可能残留在每个标签页上的面板配置
// （比如旧的 inactive.html 路径、或 enabled:false —— 那正是"点不开"的原因）。
//
// ⚠️ 只在这里（安装/更新）做一次；**不要**把它搬回 onActivated 之类的常规事件里，
//    否则又会变成"每次切标签页都重设面板"，用户关掉的侧栏会自己冒出来。
chrome.runtime.onInstalled.addListener(async () => {
  try {
    const tabs = await chrome.tabs.query({});
    for (const t of tabs) {
      try {
        await chrome.sidePanel.setOptions({ tabId: t.id, path: MAIN_PANEL, enabled: true });
      } catch (_) {}
    }
  } catch (_) {}
});
