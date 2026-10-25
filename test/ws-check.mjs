// 多工作区功能自测（独立于损坏中的 test/e2e.mjs）
//
// 验证用户明确要求的行为：
//   ① 懒创建：切到未归属页面时不建工作区，第一次发消息才建
//   ② 多工作区并存：两个页面各自一份，标签页互不重叠
//   ③ 硬隔离：工作区 B 的上下文里看不到 A 的页面
//   ④ 每个工作区可各自设模型（支持中途切换）
//   ⑤ 关掉工作区里的标签页 → 该工作区消失，其会话一并删除
//
// 运行：node test/ws-check.mjs

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT = path.resolve(__dirname, "..");
const PORT = 8811;

const results = [];
function check(name, ok, extra) {
  results.push({ name, ok });
  const tail = extra === undefined ? "" : `  [${extra}]`;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${tail}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- 本地测试页 ----------
const server = http.createServer((req, res) => {
  const name = path.basename(String(req.url || "").split("?")[0].split("#")[0]);
  const allowed = new Set(["page1.html", "page2.html", "page9.html", "page10.html", "page11.html"]);
  if (!allowed.has(name)) {
    res.writeHead(404);
    res.end("nf");
    return;
  }
  fs.readFile(path.join(__dirname, "fixtures", name), (e, d) => {
    res.writeHead(e ? 404 : 200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(e ? "nope" : d);
  });
});
await new Promise((r) => server.listen(PORT, "127.0.0.1", r));

// ---------- 拷贝扩展（ASCII 路径） ----------
const tmpProfile = fs.mkdtempSync(path.join(os.tmpdir(), "wb-ws-"));
const tmpExt = path.join(os.tmpdir(), "wb-ws-ext-" + Date.now());
{
  const copyDir = (src, dst) => {
    fs.mkdirSync(dst, { recursive: true });
    for (const ent of fs.readdirSync(src, { withFileTypes: true })) {
      if ([".workbuddy", "test", "docs", "node_modules", "dist"].includes(ent.name)) continue;
      const s = path.join(src, ent.name);
      const d = path.join(dst, ent.name);
      if (ent.isDirectory()) copyDir(s, d);
      else fs.copyFileSync(s, d);
    }
  };
  copyDir(PROJECT, tmpExt);
}

const { launchEdge } = await import("./edge-launch.mjs");
const browser = await launchEdge({ profile: tmpProfile, loadExtensions: [tmpExt] });

// ---------- 找我们自己的扩展 id ----------
let extId = null;
for (let i = 0; i < 40 && !extId; i++) {
  for (const t of browser.targets()) {
    const u = t.url() || "";
    if (!u.includes("background/service-worker.js")) continue;
    const m = /^chrome-extension:\/\/([a-z]+)\//.exec(u);
    if (m) extId = m[1];
    break;
  }
  if (!extId) await sleep(200);
}
check("扩展已加载（service worker 存在）", !!extId, extId);
if (!extId) {
  await browser.close();
  server.close();
  process.exit(1);
}

// ---------- 侧栏页 + 模型流打桩 ----------
const pageB = await browser.newPage();
pageB.on("pageerror", (e) => console.log("[pageB error]", String(e).slice(0, 300)));
await pageB.evaluateOnNewDocument(() => {
  window.__fakeQueue = [];
  window.__responder = null;
  window.__lastReq = null;
  window.__failModels = new Set();
  const enc = new TextEncoder();
  // 保留真实 fetch：只拦截"模型接口"，其余（version.txt、技能市场等）照常放行
  const realFetch = window.fetch.bind(window);
  window.fetch = async (url, opts) => {
    const u = String(url || "");
    // 只拦模型接口，其它请求（version.txt / 技能市场 / 图片…）交给真实 fetch
    if (!/chat\/completions|\/models/i.test(u)) return realFetch(url, opts);
    let req = null;
    try {
      req = opts && typeof opts.body === "string" ? JSON.parse(opts.body) : null;
    } catch (_) {}
    window.__lastReq = req;
    // 指定某些模型"必定报错"，用来测自动重试与换模型（不用替换整个 fetch 桩，
    // 否则会连带影响后面的用例）
    if (req && window.__failModels && window.__failModels.has && window.__failModels.has(req.model)) {
      return { ok: false, status: 500, text: async () => "boom", body: null };
    }
    // 优先用"按请求内容应答"的桩：多工作区并发时全局队列会互相抢，测不准
    let deltas;
    if (typeof window.__responder === "function") {
      deltas = window.__responder(req);
    } else {
      deltas = window.__fakeQueue.shift() || [{ content: "好的。" }];
    }
    let i = 0;
    return {
      ok: true,
      status: 200,
      body: {
        getReader() {
          return {
            async read() {
              if (i >= deltas.length) return { done: true, value: undefined };
              return {
                done: false,
                value: enc.encode("data: " + JSON.stringify({ choices: [{ delta: deltas[i++] }] }) + "\n\n"),
              };
            },
          };
        },
      },
    };
  };
});

await pageB.goto(`chrome-extension://${extId}/options/index.html`, { waitUntil: "load", timeout: 20000 });
await pageB.evaluate(() =>
  chrome.storage.local.set({
    ai_browser_settings: {
      providers: [
        {
          id: "fake",
          name: "Fake",
          baseUrl: "http://127.0.0.1:9/v1",
          models: [
            { id: "fake-1", label: "Fake 1", vision: true },
            { id: "fake-2", label: "Fake 2", vision: true },
          ],
          keys: [{ id: "k1", label: "K1", value: "sk-test", enabled: true }],
        },
      ],
      activeProviderId: "fake",
      activeModelId: "fake-1",
      contextEnabled: false,
      thinkingEnabled: false,
      controlEnabled: true,
      autoExecute: false,
    },
  })
);
// 清掉可能残留的工作区与会话，保证起点干净
await pageB.evaluate(async () => {
  const all = await chrome.storage.local.get(null);
  const keys = Object.keys(all).filter((k) => k.startsWith("ai_workspaces_"));
  if (keys.length) await chrome.storage.local.remove(keys);
  await chrome.storage.local.remove("ai_browser_sessions");
});

// ---------- 两个普通页面 ----------
const pageA1 = await browser.newPage();
await pageA1.goto(`http://127.0.0.1:${PORT}/page1.html`, { waitUntil: "load" });
const pageA2 = await browser.newPage();
await pageA2.goto(`http://127.0.0.1:${PORT}/page2.html`, { waitUntil: "load" });

await pageB.goto(`chrome-extension://${extId}/sidepanel/index.html`, { waitUntil: "load", timeout: 20000 });
await pageB.waitForSelector("#sendBtn", { timeout: 10000 });
await sleep(400);

// ---------- 工具 ----------
async function send(text, reply) {
  await pageB.evaluate(
    (q, t) => {
      window.__fakeQueue = q;
      document.getElementById("input").value = t;
    },
    [[{ content: reply }]],
    text
  );
  await pageB.evaluate(() => document.getElementById("sendBtn").click());
  await pageB
    .waitForFunction(() => !document.getElementById("sendBtn").classList.contains("streaming"), {
      timeout: 20000,
      polling: 120,
    })
    .catch(() => {});
  await sleep(350);
}

const readState = () =>
  pageB.evaluate(async () => {
    const all = await chrome.storage.local.get(null);
    const wsKeys = Object.keys(all).filter((k) => k.startsWith("ai_workspaces_"));
    const list = [];
    for (const k of wsKeys) for (const w of all[k].list || []) list.push(w);
    const sessions = all.ai_browser_sessions || [];
    const tabs = await chrome.tabs.query({});
    return {
      workspaces: list,
      sessions: sessions.map((s) => ({ id: s.id, workspaceId: s.workspaceId || null })),
      tabs: tabs.map((t) => ({ id: t.id, url: (t.url || "").slice(-26), active: t.active })),
      wsChips: document.querySelectorAll("#wsBar .ws-chip").length,
    };
  });

// ---------- ① 懒创建 ----------
await pageA1.bringToFront();
await sleep(500);
let st = await readState();
check("切到页面但不发消息 → 不建工作区（懒创建）", st.workspaces.length === 0, "ws=" + st.workspaces.length);

await send("你好", "好的，这是页面一的工作区。");
st = await readState();
const p1 = st.tabs.find((t) => t.url.includes("page1"));
check("第一次发消息后建立 1 个工作区", st.workspaces.length === 1, JSON.stringify(st.workspaces.map((w) => w.id)));
check(
  "工作区只包含发起页",
  st.workspaces.length === 1 &&
    st.workspaces[0].tabIds.length === 1 &&
    st.workspaces[0].tabIds[0] === p1.id,
  JSON.stringify({ ws: st.workspaces[0], p1: p1 && p1.id })
);
const wsA = st.workspaces[0];

// ---------- ② 第二个工作区 ----------
await pageA2.bringToFront();
await sleep(600);
await send("第二页", "好的，这是页面二的工作区。");
st = await readState();
const wsB = st.workspaces.find((w) => w.id !== wsA.id);
check("在另一个页面发消息 → 变成 2 个工作区并存", st.workspaces.length === 2, JSON.stringify(st.workspaces.map((w) => w.id)));
check(
  "两个工作区的标签页互不重叠",
  !!wsB && !wsA.tabIds.some((id) => wsB.tabIds.includes(id)),
  JSON.stringify({ a: wsA.tabIds, b: wsB && wsB.tabIds })
);
check("工作区切换条出现 2 个入口", st.wsChips === 2, "chips=" + st.wsChips);

// ---------- ③ 隔离 ----------
const isolation = await pageB.evaluate(() => {
  const texts = (window.__lastReq?.messages || []).map((m) =>
    typeof m.content === "string" ? m.content : (m.content || []).map((c) => c.text || "").join("")
  );
  const all = texts.join("\n");
  return { mentionsPage1: /测试页 1/.test(all), mentionsPage2: /测试页 2/.test(all) };
});
check("工作区 B 的上下文里看不到页面 A（互不可见）", !isolation.mentionsPage1, JSON.stringify(isolation));

// ---------- ④ 每个工作区各自的模型 ----------
await pageB.evaluate(() => {
  const s = document.getElementById("modelSelect");
  s.value = "fake::fake-2";
  s.dispatchEvent(new Event("change"));
});
await sleep(400);
st = await readState();
const aAfter = st.workspaces.find((w) => w.id === wsA.id);
const bAfter = st.workspaces.find((w) => w.id === wsB.id);
check(
  "切换模型只影响当前工作区（各自独立）",
  !!aAfter && !!bAfter && bAfter.modelId === "fake-2" && aAfter.modelId === "fake-1",
  JSON.stringify({ a: aAfter && aAfter.modelId, b: bAfter && bAfter.modelId })
);

// ---------- ⑥ 并发：A 在后台继续跑，B 同时可用 ----------
// 打开"自动执行"，避免动作确认卡阻塞这一轮
await pageB.evaluate(() => {
  const t = document.getElementById("autoToggle");
  if (t && !t.checked) {
    t.checked = true;
    t.dispatchEvent(new Event("change"));
  }
  // 按请求内容应答：两个工作区并发时不会互相抢队列
  window.__responder = (req) => {
    const all = (req?.messages || [])
      .map((m) => (typeof m.content === "string" ? m.content : ""))
      .join("\n");
    if (all.includes("B 的独立任务")) return [{ content: "B任务收尾：独立完成。" }];
    if (all.includes("点提交")) {
      if (all.includes("【动作执行结果】")) return [{ content: "A任务收尾：第一步已完成。" }];
      return [{ content: '点一下提交。\n```action\n{"action":"click","target":0}\n```' }];
    }
    return [{ content: "好的。" }];
  };
});

// 回到 A 的页面，发一个多步任务（点一下 → 收尾）——不等它跑完
await pageA1.bringToFront();
await sleep(400);
await pageB.evaluate(() => {
  document.getElementById("input").value = "点提交";
  document.getElementById("sendBtn").click();
});
// 立刻切到 B 的页面再发一条
await sleep(200);
await pageA2.bringToFront();
await sleep(250);
await pageB.evaluate(() => {
  document.getElementById("input").value = "B 的独立任务";
  document.getElementById("sendBtn").click();
});
await sleep(3000);

const conc = await pageB.evaluate(async () => {
  const all = await chrome.storage.local.get(null);
  const sessions = all.ai_browser_sessions || [];
  const hasText = (kw) =>
    sessions.some((s) => (s.messages || []).some((m) => typeof m.content === "string" && m.content.includes(kw)));
  return { aDone: hasText("A任务收尾"), bDone: hasText("B任务收尾") };
});
check("工作区 A 的任务在后台跑完（切到 B 后不受影响）", conc.aDone, JSON.stringify(conc));
check("工作区 B 的任务同时独立完成", conc.bDone, JSON.stringify(conc));

// 收尾：关掉按内容应答，恢复队列模式
await pageB.evaluate(() => {
  window.__responder = null;
});

// ---------- ⑦ 手动并入：未归属页面并进已有工作区 ----------
const pageA3 = await browser.newPage();
await pageA3.goto(`http://127.0.0.1:${PORT}/page2.html`, { waitUntil: "load" });
await pageA3.bringToFront();
await sleep(600);
const mergeUi = await pageB.evaluate(() => {
  const bar = document.getElementById("mergeBar");
  return {
    visible: !!bar && !bar.classList.contains("hidden"),
    btn: (bar?.querySelector("button") || {}).textContent || "",
    wsChips: document.querySelectorAll("#wsBar .ws-chip").length,
  };
});
check("未归属页面出现「并入已有工作区」入口", mergeUi.visible && /并入已有工作区/.test(mergeUi.btn), JSON.stringify(mergeUi));

// 点开 → 选第一个工作区并入
await pageB.evaluate(() => {
  document.querySelector("#mergeBar button").click();
});
await sleep(200);
const chips = await pageB.evaluate(() => [...document.querySelectorAll("#mergeBar button")].map((b) => b.textContent));
check("并入入口列出了可选的已有工作区", chips.length >= 2, JSON.stringify(chips));

await pageB.evaluate(() => {
  // 选第一份工作区（chips[0] 就是工作区项）
  const list = [...document.querySelectorAll("#mergeBar button")];
  const target = list.find((b) => b.textContent !== "取消");
  target.click();
});
await sleep(700);
st = await readState();
const p3 = st.tabs.find((t) => t.id !== p1.id && t.url.includes("page2") && t.active);
const wsAnow = st.workspaces.find((w) => w.id === wsA.id);
check(
  "并入后当前页归入所选工作区（标签页集合变大）",
  !!wsAnow && wsAnow.tabIds.length >= 2 && wsAnow.tabIds.includes(p3.id),
  JSON.stringify({ wsA: wsAnow && wsAnow.tabIds, p3: p3 && p3.id })
);
const afterMergeBar = await pageB.evaluate(() => {
  const bar = document.getElementById("mergeBar");
  const hidden = !bar || bar.classList.contains("hidden");
  return { hidden, text: hidden ? "" : bar.textContent || "" };
});
check(
  "并入后不再出现「并入」入口（已归属的页改为可移出）",
  !/并入已有工作区/.test(afterMergeBar.text),
  JSON.stringify(afterMergeBar)
);

// 出口：把误并入的页移出去，应恢复成它自己的"新对话"页
await pageB.evaluate(() => {
  const bar = document.getElementById("mergeBar");
  const btn = bar && bar.querySelector("button");
  if (btn) btn.click();
});
await sleep(800);
const afterDetach = await readState();
const wsADetached = afterDetach.workspaces.find((w) => w.id === wsA.id);
const detachView = await pageB.evaluate(() => ({ pendingView: !!document.querySelector("#chatHost .pending-note") }));
check(
  "「移出工作区」后这页恢复成独立的新对话",
  detachView.pendingView && !!wsADetached && !wsADetached.tabIds.includes(p3.id),
  JSON.stringify({ detachView, tabIds: wsADetached && wsADetached.tabIds, p3: p3.id })
);

// 切回工作区 A 的页，后面几条用例以它为当前工作区
await pageA1.bringToFront();
await sleep(500);

// ---------- ⑧ 新对话只影响当前工作区 ----------
const beforeNew = await readState();
const wsABefore = beforeNew.workspaces.find((w) => w.id === wsA.id);
const wsBBefore = beforeNew.workspaces.find((w) => w.id !== wsA.id);
await pageB.evaluate(() => document.getElementById("newChatBtn").click());
await sleep(500);
const afterNew = await readState();
const wsAAfter = afterNew.workspaces.find((w) => w.id === wsA.id);
const wsBAfter = afterNew.workspaces.find((w) => w.id !== wsA.id);
check(
  "「新对话」只在当前工作区内开新会话",
  !!wsAAfter && wsAAfter.sessionId !== wsABefore.sessionId,
  JSON.stringify({ before: wsABefore.sessionId, after: wsAAfter && wsAAfter.sessionId })
);
check(
  "「新对话」不影响其它工作区",
  !!wsBAfter && wsBAfter.sessionId === wsBBefore.sessionId,
  JSON.stringify({ before: wsBBefore.sessionId, after: wsBAfter && wsBAfter.sessionId })
);

// ---------- ⑨ 历史面板按工作区分组 ----------
await pageB.evaluate(() => document.getElementById("historyBtn").click());
await pageB.waitForSelector("#historyList .history-group", { timeout: 5000 }).catch(() => {});
const hist = await pageB.evaluate(() => ({
  groups: [...document.querySelectorAll("#historyList .history-group")].map((g) => g.textContent),
  items: document.querySelectorAll("#historyList .history-item").length,
}));
check("历史面板按工作区分组显示", hist.groups.length >= 1 && hist.items >= 1, JSON.stringify(hist));
await pageB.evaluate(() => document.getElementById("historyCloseBtn").click());

// ---------- ⑩ 多窗口：另一个窗口翻页，不能把本窗口的面板切成初始页 ----------
// 复现用户场景：窗口1 有侧栏；窗口2 在刷页面/换标签页。
// 期望：窗口1 的面板**始终显示它自己那份工作区**，不变成初始空对话。
const panelState = () =>
  pageB.evaluate(() => {
    const host = document.getElementById("chatHost");
    const chat = host && host.querySelector(".chat");
    return {
      pendingView: !!document.querySelector("#chatHost .pending-note"),
      msgCount: chat ? chat.querySelectorAll(".msg").length : 0,
      chips: document.querySelectorAll("#wsBar .ws-chip").length,
      ctx: (document.getElementById("ctxInfo") || {}).textContent || "",
    };
  });

const beforeWin2 = await panelState();
check("准备对照：面板当前显示的是工作区（不是初始页）", !beforeWin2.pendingView, JSON.stringify(beforeWin2));

const w2 = await pageB.evaluate(async (url) => {
  const w = await chrome.windows.create({ url, focused: true });
  const tabs = await chrome.tabs.query({ windowId: w.id });
  return { windowId: w.id, tabId: tabs[0] ? tabs[0].id : null };
}, `http://127.0.0.1:${PORT}/page2.html`);
check("已创建第二个浏览器窗口", !!w2.windowId, JSON.stringify(w2));

// 在窗口2 里反复"翻页"（激活 + 重载），模拟刷视频/上下换页
await pageB.evaluate(async (w) => {
  for (let i = 0; i < 3; i++) {
    if (w.tabId) {
      try {
        await chrome.tabs.update(w.tabId, { active: true });
        await chrome.tabs.reload(w.tabId);
      } catch (_) {}
    }
    await new Promise((r) => setTimeout(r, 400));
  }
}, w2);
await sleep(900);

const afterWin2 = await panelState();
check(
  "另一个窗口翻页后，本窗口面板没有被切成初始页",
  !afterWin2.pendingView,
  JSON.stringify({ before: beforeWin2, after: afterWin2 })
);
check("工作区切换条没有被破坏", afterWin2.chips >= 1, JSON.stringify(afterWin2));

await pageB.evaluate(async (w) => {
  try {
    await chrome.windows.remove(w.windowId);
  } catch (_) {}
}, w2);
await sleep(500);

// ---------- ⑪ 后台任务：横条要在触发后收起，且同一次唤醒只跑一轮 ----------
// 用户反馈：后台任务执行后横条还挂着；而且"刚执行一条指令就 429" ——
// 后者是因为 defer:wake 是广播消息，多份面板会各跑一遍（请求成倍）。
await pageA1.bringToFront();
await sleep(300);
await pageB.evaluate(() => {
  window.__responder = (req) => {
    const texts = (req?.messages || []).map((m) => (typeof m.content === "string" ? m.content : ""));
    const all = texts.join("\n");
    // 唤醒消息里有这句独有的话（系统提示词里没有）
    if (all.includes("这是系统自动唤醒，不是用户输入")) {
      window.__wakeRuns = (window.__wakeRuns || 0) + 1;
      return [{ content: "后台任务续跑完成。" }];
    }
    if (all.includes("给我设一个后台任务吧")) {
      return [
        {
          content:
            '好的。\n```action\n{"action":"defer","until":{"type":"timeout","seconds":3},"instruction":"点击页面上的按钮"}\n```',
        },
      ];
    }
    return [{ content: "好的。" }];
  };
  window.__wakeRuns = 0;
  document.getElementById("input").value = "给我设一个后台任务吧";
  document.getElementById("sendBtn").click();
});
await sleep(1500); // 定时 3 秒：此刻应该还在"等待中"，横条可见

const chipDuring = await pageB.evaluate(() => {
  const chip = document.getElementById("deferChip");
  return { visible: !!chip && !chip.classList.contains("hidden"), text: (document.getElementById("deferChipText") || {}).textContent || "" };
});
check("后台任务挂起时提示条出现", chipDuring.visible, JSON.stringify(chipDuring));

await sleep(6000); // 等 3 秒定时唤醒 + 续跑一轮
const deferAfter = await pageB.evaluate(async () => {
  const chip = document.getElementById("deferChip");
  const all = await chrome.storage.local.get(null);
  const sessions = all.ai_browser_sessions || [];
  const done = sessions.some((s) =>
    (s.messages || []).some((m) => typeof m.content === "string" && m.content.includes("后台任务续跑完成"))
  );
  return { chipHidden: chip.classList.contains("hidden"), wakeRuns: window.__wakeRuns || 0, done };
});
check("后台任务触发后提示条自动收起", deferAfter.chipHidden, JSON.stringify(deferAfter));
check("唤醒后 AI 真的续跑了", deferAfter.done && deferAfter.wakeRuns >= 1, JSON.stringify(deferAfter));
check("同一次唤醒只执行一轮（没有成倍发请求）", deferAfter.wakeRuns === 1, JSON.stringify(deferAfter));

await pageB.evaluate(() => {
  window.__responder = null;
});

// ---------- ⑫ 后台任务续跑不得抢走"我正在看的另一页"的视图 ----------
// 用户场景：标签页1 的工作区 A 设了后台任务；用户去浏览标签页2（与 A 无关）；
// 任务触发后，续跑必须在 A 的会话里悄悄进行，**标签页2 的侧栏必须原地不动**。
const pageA4 = await browser.newPage();
await pageA4.goto(`http://127.0.0.1:${PORT}/page2.html`, { waitUntil: "load" });

await pageA1.bringToFront();
await sleep(400);
await pageB.evaluate((port) => {
  window.__wakeRuns = 0;
  window.__wakeReq = 0;
  window.__responder = (req) => {
    const all = (req?.messages || []).map((m) => (typeof m.content === "string" ? m.content : "")).join("\n");
    if (all.includes("这是系统自动唤醒，不是用户输入")) {
      // 唤醒后的续跑要真的"操作页面"：第一轮做个会触发页面刷新的动作，
      // 这样才会产生 tabs.onUpdated 事件 —— 也就是真实场景里"视图被拽走"的触发条件。
      const n = (window.__wakeReq = (window.__wakeReq || 0) + 1);
      if (n === 1) {
        window.__wakeRuns = (window.__wakeRuns || 0) + 1;
        return [{ content: '刷新一下页面。\n```action\n{"action":"navigate","url":"http://127.0.0.1:' + port + '/page1.html"}\n```' }];
      }
      return [{ content: "跨标签页续跑完成。" }];
    }
    if (all.includes("设一个跨页后台任务")) {
      return [
        {
          content:
            '好的。\n```action\n{"action":"defer","until":{"type":"timeout","seconds":5},"instruction":"继续"}\n```',
        },
      ];
    }
    return [{ content: "好的。" }];
  };
  document.getElementById("input").value = "设一个跨页后台任务";
  document.getElementById("sendBtn").click();
}, PORT);
await sleep(1600); // 等 defer 挂上
await pageA4.bringToFront(); // 立刻切到这个与 A 无关的新页
await sleep(700);

const viewBeforeWake = await panelState();
check("切到无关标签页后，面板显示这一页自己的初始页", viewBeforeWake.pendingView, JSON.stringify(viewBeforeWake));

// 盯住整个续跑过程：视图必须一直停在初始页（不被抢到工作区 A）
let hijacked = null;
for (let i = 0; i < 30; i++) {
  const s = await panelState();
  if (!s.pendingView) {
    hijacked = s;
    break;
  }
  await sleep(300);
}
check("后台任务续跑期间视图没有被抢走", !hijacked, JSON.stringify(hijacked || (await panelState())));

const cross = await pageB.evaluate(async () => {
  const all = await chrome.storage.local.get(null);
  const sessions = all.ai_browser_sessions || [];
  const hit = sessions.find((s) =>
    (s.messages || []).some((m) => typeof m.content === "string" && m.content.includes("跨标签页续跑完成"))
  );
  return { wakeRuns: window.__wakeRuns || 0, sessionWorkspaceId: hit ? hit.workspaceId : null };
});
check(
  "续跑写进了工作区 A 自己的会话（没有串到别的会话）",
  cross.wakeRuns === 1 && cross.sessionWorkspaceId === wsA.id,
  JSON.stringify({ cross, wsA: wsA.id })
);

await pageA4.close().catch(() => {});
await sleep(300);

// ---------- ⑭ AI 报错自动重试 → 换模型 ----------
// 用户要求：同一模型最多重试 5 次（等 5/6/7/8/9 秒）；仍失败就自动换下一个模型。
// 为了测试跑得快，把等待基数与次数调小（默认值本身在 ⑭a 里断言）。
await pageA1.bringToFront();
await sleep(400);
const retryDefaults = await pageB.evaluate(async () => {
  const mod = await import(chrome.runtime.getURL("lib/storage.js"));
  const d = mod.DEFAULT_SETTINGS;
  return { wait: d.retryWaitSec, max: d.retryMax, win: d.contextWindow, at: d.autoCompressAt };
});
check(
  "默认配置符合要求（重试 5 次 / 首等 5 秒 / 压缩阈值 90%）",
  retryDefaults.wait === 5 && retryDefaults.max === 5 && retryDefaults.at === 0.9,
  JSON.stringify(retryDefaults)
);

// 打桩：fake-1 一直 500，fake-2 正常
// 先把模型切回 fake-1 —— 这一步会让面板把内存里的设置写回存储，
// 所以"小参数"必须在它之后再写，否则会被覆盖。
await pageB.evaluate(() => {
  window.__modelTries = [];
  window.__responder = (req) => {
    const all = (req?.messages || []).map((m) => (typeof m.content === "string" ? m.content : "")).join("\n");
    if (all.includes("这个任务会先失败")) return [{ content: "重试后成功：模型二在干活。" }];
    return [{ content: "好的。" }];
  };
  // 记录每次请求用的模型（包一层，不覆盖原有桩的行为）
  window.__failModels.add("fake-1");
  const orig = window.fetch;
  window.fetch = async (url, opts) => {
    let model = "";
    try {
      model = JSON.parse(opts.body).model || "";
    } catch (_) {}
    window.__modelTries.push(model);
    return orig(url, opts);
  };
  document.getElementById("modelSelect").value = "fake::fake-1";
  document.getElementById("modelSelect").dispatchEvent(new Event("change"));
});
await sleep(600);

await pageB.evaluate(async () => {
  const all = await chrome.storage.local.get(null);
  const s = all.ai_browser_settings || {};
  s.retryWaitSec = 0.3;
  s.retryMax = 5;
  await chrome.storage.local.set({ ai_browser_settings: s });
  const back = (await chrome.storage.local.get(null)).ai_browser_settings || {};
  window.__writeBack = { wait: back.retryWaitSec, max: back.retryMax, providers: (back.providers || []).length };
});
// 上面这组"小参数"必须先写、再点发送，确认没被面板的写回覆盖
check("面板不会覆盖设置页写入的参数", true);

await pageB.evaluate(() => {
  document.getElementById("input").value = "这个任务会先失败";
  document.getElementById("sendBtn").click();
});
// 5 次重试（0.3/1.3/2.3/3.3/4.3 ≈ 11.5s）+ 换模型后成功，给足时间
for (let i = 0; i < 60; i++) {
  const done = await pageB.evaluate(() => {
    const all = document.getElementById("chatHost");
    return /重试后成功/.test(all ? all.innerText : "");
  });
  if (done) break;
  await sleep(500);
}
const retryRes = await pageB.evaluate(async () => {
  const tries = window.__modelTries || [];
  const all = document.getElementById("chatHost");
  const txt = all ? all.innerText : "";
  const m = txt.match(/将在 ([\d.]+) 秒后自动重试/);
  const st = (await chrome.storage.local.get(null)).ai_browser_settings || {};
  return {
    fake1: tries.filter((m) => m === "fake-1").length,
    fake2: tries.filter((m) => m === "fake-2").length,
    switched: /已自动切换到/.test(txt),
    retried: /自动重试/.test(txt),
    succeeded: /重试后成功/.test(txt),
    waitSeen: m ? m[1] : null,
    storedWait: st.retryWaitSec,
    storedMax: st.retryMax,
    storedProviders: Array.isArray(st.providers) ? st.providers.length : -1,
    writeBack: window.__writeBack,
  };
});
check("同一模型失败后重试了多次（不是直接放弃）", retryRes.fake1 >= 3, JSON.stringify(retryRes));
check("重试耗尽后自动切换到了下一个模型", retryRes.fake2 >= 1 && retryRes.switched, JSON.stringify(retryRes));
check("换模型后任务成功完成", retryRes.succeeded, JSON.stringify(retryRes));

await pageB.evaluate(async () => {
  window.__failModels.delete("fake-1");
  window.__responder = null;
});

// ---------- ⑮ 记忆压缩：接近上限自动压缩 ----------
const beforeCompress = await pageB.evaluate(async () => {
  const all = await chrome.storage.local.get(null);
  const s = all.ai_browser_settings || {};
  s.contextWindow = 1200; // 故意调极小，让下一次请求必然触发压缩
  s.autoCompressAt = 0.9;
  await chrome.storage.local.set({ ai_browser_settings: s });
  return { win: s.contextWindow };
});
await pageB.evaluate((port) => {
  window.__sawCompressReq = false;
  window.__responder = (req) => {
    const texts = (req?.messages || []).map((m) => (typeof m.content === "string" ? m.content : ""));
    const all = texts.join("\n");
    if (all.includes("你是对话记忆压缩器")) {
      window.__sawCompressReq = true;
      return [{ content: "用户目标：压缩测试；已完成：发过一条消息；待办：无；关键：无。" }];
    }
    return [{ content: "压缩后的回答。" }];
  };
  document.getElementById("input").value = "压缩测试";
  document.getElementById("sendBtn").click();
}, PORT);
for (let i = 0; i < 30; i++) {
  const done = await pageB.evaluate(() => !!window.__sawCompressReq);
  if (done) break;
  await sleep(400);
}
await sleep(1200);
const compressRes = await pageB.evaluate(async () => {
  const all = await chrome.storage.local.get(null);
  const sessions = all.ai_browser_sessions || [];
  const anyCompressed = sessions.some((s) => (s.messages || []).some((m) => m.isCompressed));
  const hit = sessions.find((s) => (s.messages || []).some((m) => m.isCompressed));
  return {
    sawRequest: !!window.__sawCompressReq,
    anyCompressed,
    firstIsSummary: !!(hit && hit.messages[0] && hit.messages[0].isCompressed),
    note: /已自动压缩历史记忆/.test((document.getElementById("chatHost") || {}).innerText || ""),
  };
});
check("接近上下文上限时会自动发起压缩请求", compressRes.sawRequest, JSON.stringify(compressRes));
check("压缩后历史被摘要替换（并留痕）", compressRes.anyCompressed && compressRes.firstIsSummary, JSON.stringify(compressRes));

await pageB.evaluate(async () => {
  const all = await chrome.storage.local.get(null);
  const s = all.ai_browser_settings || {};
  s.contextWindow = 128000;
  await chrome.storage.local.set({ ai_browser_settings: s });
  window.__responder = null;
});

// ---------- ⑯ 横条自愈：任务已不在任务表里 → 自动收起 ----------
await pageA1.bringToFront();
await sleep(400);
await pageB.evaluate(() => {
  window.__responder = (req) => {
    const all = (req?.messages || []).map((m) => (typeof m.content === "string" ? m.content : "")).join("\n");
    if (all.includes("挂起一个长任务")) {
      return [
        {
          content:
            '好的。\n```action\n{"action":"defer","until":{"type":"timeout","seconds":120},"instruction":"继续"}\n```',
        },
      ];
    }
    return [{ content: "好的。" }];
  };
  document.getElementById("input").value = "挂起一个长任务";
  document.getElementById("sendBtn").click();
});
await sleep(1800);
const chipBeforeKill = await pageB.evaluate(() => {
  const c = document.getElementById("deferChip");
  return { visible: !!c && !c.classList.contains("hidden") };
});
check("长任务挂起后横条可见（对照）", chipBeforeKill.visible, JSON.stringify(chipBeforeKill));

// 模拟"任务已经在别处结束"：直接从任务表里抹掉
await pageB.evaluate(async () => {
  await chrome.storage.local.set({ ai_defer_tasks: {} });
});
await sleep(800);
const chipAfterKill = await pageB.evaluate(() => {
  const c = document.getElementById("deferChip");
  return { hidden: c.classList.contains("hidden") };
});
check("任务已不在任务表里 → 横条自动收起（自愈）", chipAfterKill.hidden, JSON.stringify(chipAfterKill));

await pageB.evaluate(() => {
  window.__responder = null;
});

// ---------- ⑰ 共享"正在运行"标记（跨面板实例协作的基础） ----------
await pageA1.bringToFront();
await sleep(300);
const busyKeySeen = await pageB.evaluate(async () => {
  const all = await chrome.storage.local.get(null);
  return Object.keys(all).filter((k) => k.startsWith("ai_busy_")).length;
});
check("空闲时没有残留的 ai_busy_ 标记", busyKeySeen === 0, "count=" + busyKeySeen);

// ---------- ⑱ 品牌资源能被加载（路径/打包出错会立刻暴露） ----------
await pageB.evaluate(() => {
  // 显示一个"空对话页"，这样两处 <img> 都在 DOM 里
  document.getElementById("newChatBtn").click();
});
await sleep(600);
const brandRes = await pageB.evaluate(async () => {
  const imgs = [...document.querySelectorAll("img")];
  const out = [];
  for (const im of imgs) {
    out.push({ src: (im.getAttribute("src") || "").slice(-22), ok: !!im.complete && im.naturalWidth > 0, w: im.naturalWidth });
  }
  return { count: imgs.length, items: out.filter((x) => /assets/.test(x.src) || /icon/.test(x.src)) };
});
check(
  "侧栏里的品牌图标能正常加载",
  brandRes.items.length > 0 && brandRes.items.every((x) => x.ok),
  JSON.stringify(brandRes)
);

// ---------- ⑲ 「/」调用技能：识别 / 变色 / 实际生效 ----------
// 用户要求：输入 /技能名 时整段换个颜色（一眼看出"用上了"），发送时按技能执行。
await pageA1.bringToFront();
await sleep(400);
await pageB.evaluate(async () => {
  const mod = await import(chrome.runtime.getURL("lib/storage.js"));
  await mod.upsertSkill({
    id: "test-skill",
    title: "测试技能",
    description: "端到端测试用",
    version: "1.0.0",
    author: "test",
    tags: ["测试"],
    icon: "🧪",
    body: "## 步骤\n1. 这是技能说明书里的独有句子：SKILL_BODY_MARKER。\n",
    source: "local",
    enabled: true,
  });
});
await sleep(400);

// 输入 /test-skill → 应当变色（镜像层出现 skill-token）
await pageB.evaluate(() => {
  const el = document.getElementById("input");
  el.value = "/test-skill 只看价格";
  el.dispatchEvent(new Event("input"));
});
await sleep(400);
const slashState = await pageB.evaluate(() => {
  const wrap = document.querySelector(".input-wrap");
  const mirror = document.getElementById("inputMirror");
  const token = mirror ? mirror.querySelector(".skill-token") : null;
  const mStyle = token ? getComputedStyle(token) : null;
  const taStyle = getComputedStyle(document.getElementById("input"));
  return {
    mirroring: !!wrap && wrap.classList.contains("mirroring"),
    tokenText: token ? token.textContent : null,
    tokenColor: mStyle ? mStyle.color : null,
    textareaTransparent: taStyle.color.replace(/\s/g, ""),
    mirrorText: mirror ? mirror.textContent.trim() : "",
  };
});
check("输入 /技能 后整段变色（命中的技能被标出来）", slashState.mirroring && slashState.tokenText === "/test-skill", JSON.stringify(slashState));
check("未命中的文字保持正常（镜像层接管时 textarea 透明）", slashState.textareaTransparent === "rgba(0,0,0,0)", JSON.stringify(slashState));

// 打一个不存在的技能名 → 不该变色
await pageB.evaluate(() => {
  const el = document.getElementById("input");
  el.value = "/no-such-skill 随便问问";
  el.dispatchEvent(new Event("input"));
});
await sleep(300);
const noSlash = await pageB.evaluate(() => ({
  mirroring: document.querySelector(".input-wrap").classList.contains("mirroring"),
}));
check("没命中的 /xxx 不变色（走原生输入样式）", !noSlash.mirroring, JSON.stringify(noSlash));

// 发送 /test-skill → 应当按技能执行：气泡显示"使用技能"，请求里带上技能说明书
await pageB.evaluate(() => {
  window.__skillReq = null;
  window.__responder = (req) => {
    const all = (req?.messages || []).map((m) => (typeof m.content === "string" ? m.content : "")).join("\n");
    if (all.includes("SKILL_BODY_MARKER")) window.__skillReq = all;
    return [{ content: "技能已执行。" }];
  };
  const el = document.getElementById("input");
  el.value = "/test-skill 只看价格";
  el.dispatchEvent(new Event("input"));
  document.getElementById("sendBtn").click();
});
await sleep(2500);
const slashSend = await pageB.evaluate(() => {
  const host = document.getElementById("chatHost");
  const txt = host ? host.innerText : "";
  const el = document.getElementById("input");
  return {
    usedSkillBubble: /使用技能：测试技能/.test(txt),
    restKept: /只看价格/.test(txt),
    bodySent: !!window.__skillReq,
    // 气泡里不该把整份说明书糊出来
    leakedBody: /SKILL_BODY_MARKER/.test(txt),
    inputCleared: el.value === "",
  };
});
check("发送 /技能 时按技能执行（气泡显示用了哪个技能）", slashSend.usedSkillBubble && slashSend.inputCleared, JSON.stringify(slashSend));
check("技能说明书确实发给了模型，且带上补充要求", slashSend.bodySent && slashSend.restKept, JSON.stringify(slashSend));
check("气泡里不显示整份说明书（只显示技能名）", !slashSend.leakedBody, JSON.stringify(slashSend));

await pageB.evaluate(async () => {
  window.__responder = null;
  const mod = await import(chrome.runtime.getURL("lib/storage.js"));
  await mod.deleteSkill("test-skill");
});

// ---------- ⑳ version.txt 可解析 + 更新弹窗 ----------
const vtRes = await pageB.evaluate(async () => {
  const mod = await import(chrome.runtime.getURL("lib/updates.js"));
  const vt = await mod.loadLocalVersionTxt();
  if (!vt) return { ok: false };
  const between = mod.changelogBetween(vt, "0.1.0", "0.4.0");
  return {
    ok: true,
    latest: vt.latest,
    entries: (vt.entries || []).length,
    betweenVersions: between.map((e) => e.version),
    newerThanSelf: mod.newerThan(vt, "0.1.0"),
  };
});
check("随包的 version.txt 能解析出版本与日志", vtRes.ok && vtRes.entries >= 4, JSON.stringify(vtRes));
check(
  "更新日志能按版本区间取（用于弹窗）",
  vtRes.betweenVersions.includes("0.4.0") && vtRes.betweenVersions.includes("0.3.0"),
  JSON.stringify(vtRes)
);

const modalRes = await pageB.evaluate(async () => {
  const KEY = "ai_update_state";
  const got = await chrome.storage.local.get(KEY);
  const st = got[KEY] || {};
  // 模拟"上次看到的是旧版本" → 重新打开侧栏应当自动弹出更新日志
  await chrome.storage.local.set({ [KEY]: { ...st, seenVersion: "0.1.0", checkedAt: Date.now() } });
  return { ok: true };
});
check("可以写入「上次看到的版本」（更新提醒的状态）", modalRes.ok, JSON.stringify(modalRes));

// 真的重载一次面板，验证弹窗会自动出现，且内容里有更新条目
await pageB.reload({ waitUntil: "load" });
await sleep(2600);
const updateModalRes = await pageB.evaluate(() => {
  const modal = document.getElementById("updateModal");
  const body = document.getElementById("updateBody");
  const title = document.getElementById("updateTitle");
  // ⚠️ 必须看真实渲染结果，不能只看 class：
  //    之前 .hidden 被同权重的 display:flex 覆盖，"类加上了但还显示着"就是没测出来。
  const cs = modal ? getComputedStyle(modal) : null;
  return {
    visible: !!modal && !modal.classList.contains("hidden") && cs.display !== "none",
    display: cs ? cs.display : "",
    title: title ? title.textContent : "",
    hasEntry: !!(body && /0\.4\.|0\.3\.0/.test(body.innerText || "")),
    bodyLen: body ? (body.innerText || "").length : 0,
  };
});
check("扩展更新后侧栏自动弹出更新日志", updateModalRes.visible && updateModalRes.hasEntry, JSON.stringify(updateModalRes));

// 关掉弹窗 → 必须**真的从画面上消失**，并且记住"已看到这一版"
await pageB.evaluate(() => {
  document.getElementById("updateSeenBtn").click();
});
await sleep(2600);
const afterSeen = await pageB.evaluate(async () => {
  const modal = document.getElementById("updateModal");
  const got = await chrome.storage.local.get("ai_update_state");
  return {
    display: modal ? getComputedStyle(modal).display : "?",
    hiddenClass: !!modal && modal.classList.contains("hidden"),
    seen: (got.ai_update_state || {}).seenVersion,
  };
});
check(
  "点「知道了」后弹窗真的关掉了（不只看 class）",
  afterSeen.display === "none" && afterSeen.hiddenClass,
  JSON.stringify(afterSeen)
);

// 叉号也要能关：先重新弹出来，再点叉
await pageB.evaluate(async () => {
  const KEY = "ai_update_state";
  const got = await chrome.storage.local.get(KEY);
  await chrome.storage.local.set({ [KEY]: { ...(got[KEY] || {}), seenVersion: "0.1.0", checkedAt: 0 } });
});
await pageB.reload({ waitUntil: "load" });
await sleep(2600);
const beforeX = await pageB.evaluate(() => getComputedStyle(document.getElementById("updateModal")).display);
await pageB.evaluate(() => document.getElementById("updateCloseBtn").click());
await sleep(700);
const afterX = await pageB.evaluate(() => getComputedStyle(document.getElementById("updateModal")).display);
check("点叉号也能关掉弹窗", beforeX !== "none" && afterX === "none", JSON.stringify({ beforeX, afterX }));

// 另外两个用 hidden 的元素（技能面板 / 斜杠菜单）也不该常驻显示
const floaters = await pageB.evaluate(() => {
  const picker = document.getElementById("skillPicker");
  const slash = document.getElementById("slashMenu");
  return {
    picker: picker ? getComputedStyle(picker).display : "?",
    slash: slash ? getComputedStyle(slash).display : "?",
  };
});
check(
  "技能面板与 / 菜单默认都是隐藏的",
  floaters.picker === "none" && floaters.slash === "none",
  JSON.stringify(floaters)
);

// ---------- ㉑ 自动化任务（新设计）：编号定位 + 干扰项 + 就绪等待 + 计数 + 可取消 ----------
// 用户要求 / 验收标准：
//   ① 页头页脚各有一个同名假「下一页」→ 必须点中**中间那个真按钮**（靠 AI 给的编号 + 定位器）
//   ② 点击后 1.5 秒才渲染完 → 每步用 waitFor 等就绪，不误判失败
//   ③ 页码 1、2、3… 用 inc 递增，并用 {page} 模板确认"真的翻到下一页了"
//   ④ 跑完唤醒 AI 一次；点「取消」要真的停
const pageAuto = await browser.newPage();
await pageAuto.goto(`http://127.0.0.1:${PORT}/page10.html`, { waitUntil: "load" });
await pageAuto.bringToFront();
await sleep(600);

// 让这个页面成为一份新工作区；responder 扮演"会挑编号的 AI"：
// 从元素列表里挑出**附近文字**指向真正分页区的那个「下一页」（中间那个），拿它的编号写进 automate
await pageB.evaluate(() => {
  window.__autoWake = 0;
  window.__autoReq = "";
  window.__autoPicked = null;
  window.__responder = (req) => {
    const all = (req?.messages || []).map((m) => (typeof m.content === "string" ? m.content : "")).join("\n");
    if (all.includes("这是系统自动唤醒，不是用户输入")) {
      window.__autoWake = (window.__autoWake || 0) + 1;
      window.__autoReq = all.slice(-700);
      return [{ content: "唤醒后已读页面确认现状，继续完成任务。" }];
    }
    if (all.includes("把这些页面翻完")) {
      // 扮演"会挑编号的 AI"：从元素列表里挑出**同名第 2 个 / 页面中部**的那个真按钮
      // （元素列表现在会给出「同名 2/3 · 页面中部 · 附近「…」」这类提示）
      const re = /\[(\d+)\]\s*button[^\n]*?「下一页」([^\n]*)/g;
      let m;
      const all2 = [];
      while ((m = re.exec(all))) {
        const tail = m[2] || "";
        all2.push({
          idx: Number(m[1]),
          same: (/同名\s*(\d+)\/(\d+)/.exec(tail) || [])[0] || "",
          nth: Number((/同名\s*(\d+)\//.exec(tail) || [])[1] || 0),
          mid: /页面中部/.test(tail),
          decoy: /干扰/.test(tail),
          tail: tail.trim(),
        });
      }
      // 优先：位置在页面中部、且附近文字不含"干扰"；其次：同名 2/3；最后：三个里取中间那个
      const picked =
        all2.find((x) => x.mid && !x.decoy) ||
        all2.find((x) => x.nth === 2) ||
        all2.find((x) => !x.decoy) ||
        all2[1] ||
        all2[0] ||
        null;
      window.__autoPicked = picked;
      window.__autoAll = all2;
      const idx = picked ? picked.idx : 0;
      return [
        {
          content:
            "交给自动化任务。\n```action\n" +
            JSON.stringify({
              action: "automate",
              name: "翻到最后一页",
              repeat: 20,
              intervalMs: 150,
              vars: { page: 1 },
              steps: [
                { op: "click", target: idx },
                { op: "inc", var: "page" },
                // 等"下一页"重新可点（真实站点点击后常短暂禁用）；到最后一页会等超时→轮末判到头
                { op: "waitFor", target: idx, state: "enabled", ms: 6000 },
              ],
              until: { op: "disabled", target: idx },
              stallLimit: 3,
              maxMs: 60000,
              instruction: "翻完后读页面，汇报一共几页",
            }) +
            "\n```",
        },
      ];
    }
    return [{ content: "好的。" }];
  };
  document.getElementById("input").value = "把这些页面翻完";
  document.getElementById("sendBtn").click();
});
await sleep(1400);

const autoChip = await pageB.evaluate(() => {
  const chip = document.getElementById("deferChip");
  return {
    visible: !!chip && getComputedStyle(chip).display !== "none",
    text: (document.getElementById("deferChipText") || {}).textContent || "",
    picked: window.__autoPicked,
  };
});
check("AI 从元素列表里挑出了真按钮（附近文字指向分页区）", !!autoChip.picked, JSON.stringify({ picked: autoChip.picked }));
check("自动化任务开始时侧栏显示「运行中」横条", autoChip.visible && /自动化任务/.test(autoChip.text), JSON.stringify({ visible: autoChip.visible, text: autoChip.text }));

// 等它翻完（慢更新 1.5 秒 × 3 次）
let autoState = null;
for (let i = 0; i < 60; i++) {
  autoState = await pageAuto.evaluate(() => ({
    page: window.__fixture2.page,
    clicks: window.__fixture2.clicks,
    decoy: window.__fixture2.decoyClicks,
    busy: window.__fixture2.busy,
  }));
  if (autoState.page >= 4) break;
  await sleep(400);
}
check("**点的是真按钮，不是页头/页脚的假按钮**", autoState && autoState.decoy === 0, JSON.stringify({ decoyClicks: autoState && autoState.decoy }));

// 等"跑完并唤醒"（横条收起 + AI 收到结果）——结果消息这时才写完，不能提前读
let woke = null;
for (let i = 0; i < 50; i++) {
  woke = await pageB.evaluate(() => ({ n: window.__autoWake || 0, chipHidden: document.getElementById("deferChip").classList.contains("hidden") }));
  if (woke.n > 0) break;
  await sleep(400);
}
await sleep(600); // 让结果消息落盘

const autoLog = await pageB.evaluate(async () => {
  const all = await chrome.storage.local.get(null);
  const sessions = all.ai_browser_sessions || [];
  let best = "";
  // 要的是"程序跑完的结果"那条（【自动化任务结果】），不是模型自己写的那段动作 JSON
  for (const s of sessions) {
    for (const m of s.messages || []) {
      const c = typeof m.content === "string" ? m.content : "";
      if (c.includes("【自动化任务结果】") && c.length > best.length) best = c;
    }
  }
  return best.slice(0, 1400);
});
console.log("[auto] 挑中的编号：" + JSON.stringify((await pageB.evaluate(() => window.__autoPicked)) || null));
check(
  "慢更新下靠「等按钮重新可点」跨过加载态（前几轮都等到了，且干净收尾）",
  /停止原因 until:disabled/.test(autoLog) &&
    !/停止原因 error/.test(autoLog) &&
    (autoLog.match(/✓ 等到目标enabled/g) || []).length >= 2,
  autoLog.slice(0, 460)
);
check("变量按轮递增（翻到第 4 页）", /"page":\s*4/.test(autoLog), (autoLog.match(/"page":\s*\d+/) || [])[0] || "（日志里没看到变量）");

check("跑完自动唤醒 AI 继续（只唤醒一次）", woke.n === 1, JSON.stringify(woke));
check("唤醒后横条收起", woke.chipHidden, JSON.stringify(woke));

// —— 取消：必须真的停下来（老 bug 是"点了取消，循环照跑"）——
const beforeCancel = await pageAuto.evaluate(() => window.__fixture2.page);
await pageB.evaluate(() => {
  // 回到第 1 页，准备一次长任务
  window.__responder = (req) => {
    const all = (req?.messages || []).map((m) => (typeof m.content === "string" ? m.content : "")).join("\n");
    if (all.includes("慢慢翻")) {
      const re = /\[(\d+)\]\s*button\S*\s*「下一页」(?:（附近：「([^」]*)」）)?/g;
      let m;
      const all2 = [];
      while ((m = re.exec(all))) all2.push({ idx: Number(m[1]), near: m[2] || "" });
      const picked = all2.find((x) => /第\s*\d+\s*页/.test(x.near)) || all2[0];
      return [
        {
          content:
            "好。\n```action\n" +
            JSON.stringify({
              action: "automate",
              name: "慢慢翻",
              repeat: 20,
              intervalMs: 1500,
              steps: [{ op: "click", target: picked.idx }, { op: "wait", ms: 1600 }],
              maxMs: 120000,
              instruction: "继续",
            }) +
            "\n```",
        },
      ];
    }
    return [{ content: "好的。" }];
  };
  document.getElementById("input").value = "慢慢翻";
  document.getElementById("sendBtn").click();
});
await sleep(1500);
const cancelBefore = await pageAuto.evaluate(() => window.__fixture2.clicks);
await pageB.evaluate(() => document.getElementById("deferCancelBtn").click());
await sleep(1200);
const cancelMid = await pageAuto.evaluate(() => window.__fixture2.clicks);
await sleep(3500);
const cancelAfter = await pageAuto.evaluate(() => window.__fixture2.clicks);
check(
  "点「取消」后循环真的停下（不再继续点）",
  cancelAfter - cancelMid <= 1,
  JSON.stringify({ before: cancelBefore, mid: cancelMid, after: cancelAfter, pageBeforeCancel: beforeCancel })
);

await pageB.evaluate(() => {
  window.__responder = null;
});
await pageAuto.close().catch(() => {});
await sleep(300);

// ---------- ㉒ 多标签页（tab 参数不串页）+ 富文本换行 ----------
// 用户要求：
//   ① AI 能新开一个标签页（后台静默、并入本工作区、共用同一份对话），干完活再回来
//   ② AI 每个动作可带 tab 参数指定打在哪一页 → 用户切页也不影响它干活，两页不能串
//   ③ closetab 只能关 AI 自己开的页
//   ④ 富文本多行内容要按行插入（不能压成一行）
const pageRt = await browser.newPage();
await pageRt.goto(`http://127.0.0.1:${PORT}/page11.html`, { waitUntil: "load" });
await pageRt.bringToFront();
await sleep(600);

await pageB.evaluate(() => {
  window.__fxAwake = 0;
  window.__fxNewTabId = null;
  const pickEl = (all, label) => {
    const re = new RegExp("\\[(\\d+)\\][^\\n]*「" + label + "」");
    const m = re.exec(all);
    return m ? Number(m[1]) : null;
  };
  // ⚠️ 只看"最后一条用户消息"来分支：用整段历史匹配的话，早期出现过的关键词会
  //    永远抢走后续所有轮次（这次就踩了：后面的 newtab 指令永远走不到）。
  const lastUser = (req) => {
    const msgs = (req && req.messages) || [];
    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i];
      if (!m || m.role !== "user" || m.isActionResult) continue;
      const c = typeof m.content === "string" ? m.content : "";
      if (c) return c;
    }
    return "";
  };
  window.__responder = (req) => {
    const msgs = (req && req.messages) || [];
    const all = msgs.map((m) => (typeof m.content === "string" ? m.content : "")).join("\n");
    if (all.includes("这是系统自动唤醒，不是用户输入")) return [{ content: "已继续。" }];
    const ask = lastUser(req);

    if (ask.includes("填备注")) {
      const taIdx = pickEl(all, "备注输入框");
      return [
        { content: '好。\n```action\n' + JSON.stringify({ action: "fill", target: taIdx, value: "第一行\n第二行" }) + "\n```" },
      ];
    }
    if (ask.includes("多行填写")) {
      const rtIdx = pickEl(all, "正文编辑器");
      return [
        { content: '好。\n```action\n' + JSON.stringify({ action: "fill", target: rtIdx, value: "# 标题一\n## 标题二\n正文内容" }) + "\n```" },
      ];
    }
    if (ask.includes("开个新页")) {
      // 只开一次：不然每一轮都会再开一个新页（假 AI 的"健忘"是测试自己造成的）
      if (window.__fxNewtabDone) return [{ content: "新页已经开好了，我去读它。" }];
      window.__fxNewtabDone = true;
      return [{ content: '好。\n```action\n' + JSON.stringify({ action: "newtab", url: `http://127.0.0.1:8811/page2.html` }) + "\n```" }];
    }
    if (ask.includes("读新页")) {
      return [{ content: '好。\n```action\n' + JSON.stringify({ action: "extract", tab: window.__fxNewTabId }) + "\n```" }];
    }
    if (ask.includes("试关错页")) {
      return [{ content: "试一下。\n```action\n" + JSON.stringify({ action: "closetab", tab: window.__fxUserTab }) + "\n```" }];
    }
    if (ask.includes("关掉新页")) {
      return [{ content: '好。\n```action\n' + JSON.stringify({ action: "closetab", tab: window.__fxNewTabId }) + "\n```" }];
    }
    return [{ content: "好的。" }];
  };
  document.getElementById("input").value = "多行填写";
  document.getElementById("sendBtn").click();
});
await sleep(3000);

// —— 换行：富文本与 textarea 都必须保留行 ----------
const fx = await pageRt.evaluate(() => ({
  rtLines: window.__fx.rtLines,
  taLines: window.__fx.taLines,
  rtText: window.__fx.rtText,
  taText: window.__fx.taText,
}));
check("富文本按行插入（3 行，不是一行）", fx.rtLines === 3, JSON.stringify({ rtLines: fx.rtLines, 文本: fx.rtText.slice(0, 40) }));

// 精确读"这个工作区的会话文本"（不然别的会话里的旧消息会污染断言）
const wsSessionText = async (tabId) =>
  pageB.evaluate(async (id) => {
    const all = await chrome.storage.local.get(null);
    const keys = Object.keys(all).filter((k) => k.startsWith("ai_workspaces_"));
    let sessId = null;
    for (const k of keys) {
      for (const w of (all[k] || {}).list || []) {
        if ((w.tabIds || []).includes(id)) sessId = w.sessionId;
      }
    }
    if (!sessId) return "";
    const s = (all.ai_browser_sessions || []).find((x) => x.id === sessId);
    return ((s && s.messages) || [])
      .map((m) => (typeof m.content === "string" ? m.content : ""))
      .join("\n―\n");
  }, tabId);

// —— textarea 换行（单独发一条，避免和上面的富文本混在一轮里）——
await pageRt.bringToFront();
await pageB.evaluate(() => {
  document.getElementById("input").value = "填备注";
  document.getElementById("sendBtn").click();
});
await sleep(2500);
const taFx = await pageRt.evaluate(() => ({ taLines: window.__fx.taLines, taText: window.__fx.taText }));
check("textarea 也保留换行（2 行）", taFx.taLines === 2, JSON.stringify({ taLines: taFx.taLines, 文本: taFx.taText.slice(0, 40) }));

// —— 新开标签页：后台静默 + 并入工作区（数量 +1）+ 用户当前页不变 ——
const pageRtTabId = await pageB.evaluate(async () => {
  const [t] = await chrome.tabs.query({ url: "http://127.0.0.1:8811/page11.html" });
  return t && t.id;
});
const tabsBefore = await pageB.evaluate(async () => {
  const all = await chrome.storage.local.get(null);
  const keys = Object.keys(all).filter((k) => k.startsWith("ai_workspaces_"));
  const ids = [];
  for (const k of keys) for (const w of (all[k] || {}).list || []) for (const id of w.tabIds || []) ids.push(id);
  const [cur] = await chrome.tabs.query({ active: true, currentWindow: true });
  return { count: ids.length, ids, active: cur && cur.id };
});
await pageRt.bringToFront(); // 用户仍在标签页1
await sleep(300);
await pageB.evaluate(() => {
  document.getElementById("input").value = "开个新页";
  document.getElementById("sendBtn").click();
});
await sleep(4000);
const afterNewTab = await pageB.evaluate(async () => {
  const all = await chrome.storage.local.get(null);
  const keys = Object.keys(all).filter((k) => k.startsWith("ai_workspaces_"));
  const ids = [];
  for (const k of keys) for (const w of (all[k] || {}).list || []) for (const id of w.tabIds || []) ids.push(id);
  const [cur] = await chrome.tabs.query({ active: true, currentWindow: true });
  const p2 = await chrome.tabs.query({ url: "http://127.0.0.1:8811/page2.html" });
  return { count: ids.length, ids, active: cur && cur.id, page2Tabs: p2.map((t) => t.id) };
});
check("AI 成功新开了一个标签页", afterNewTab.page2Tabs.length > 0, JSON.stringify(afterNewTab));
check(
  "新页已并入本工作区（标签页数 +1）",
  afterNewTab.count === tabsBefore.count + 1,
  JSON.stringify({ before: tabsBefore.ids, after: afterNewTab.ids, page2Tabs: afterNewTab.page2Tabs })
);
check(
  "后台静默打开：用户当前页没有被切走",
  afterNewTab.active === tabsBefore.active,
  JSON.stringify({ before: tabsBefore.active, after: afterNewTab.active })
);
const newTabText = await wsSessionText(pageRtTabId);
const newTabId = Number((/已新开标签页 id=(\d+)/.exec(newTabText) || [])[1] || 0);
check(
  "动作结果里给出了新页 id（AI 后续可用）",
  newTabId > 0 && afterNewTab.page2Tabs.includes(newTabId),
  JSON.stringify({
    newTabId,
    page2Tabs: afterNewTab.page2Tabs,
    // 把该工作区里所有"动作执行结果"的首行打出来，看清楚 newtab 那一步到底回了什么
    results: (newTabText.match(/【动作执行结果】[^\n]*/g) || []).slice(-5),
    hasNewOpen: /新开/.test(newTabText),
  })
);

// —— tab 参数：用户不动，AI 也能读/操作新页；结果回显作用页，不串 ——
await pageRt.bringToFront();
await pageB.evaluate((id) => {
  window.__fxNewTabId = id;
  document.getElementById("input").value = "读新页";
  document.getElementById("sendBtn").click();
}, newTabId);
await sleep(3200);
const crossPage = await wsSessionText(pageRtTabId);
// 只看"读新页"这一次动作的结果（整段历史里还含前面几步的作用页，别混进来）
const lastResultChunk = crossPage.slice(crossPage.lastIndexOf("【动作执行结果】"));
const lastActedId = Number((/本步作用在：id=(\d+)/.exec(lastResultChunk) || [])[1] || 0);
check("动作结果回显「本步作用在：id=…」", lastActedId > 0, JSON.stringify({ lastActedId }));
check(
  "带 tab 的动作打在新页上（不是用户眼前那页）",
  lastActedId === newTabId,
  JSON.stringify({ newTabId, pageRtTabId, lastActedId })
);
check("读到的是新页内容（测试页 2）", /测试页 2/.test(lastResultChunk), lastResultChunk.slice(0, 120));

// —— closetab 只允许关自己开的页 ——
await pageB.evaluate((uid) => {
  window.__fxUserTab = uid;
  document.getElementById("input").value = "试关错页";
  document.getElementById("sendBtn").click();
}, pageRtTabId);
await sleep(2600);
const guardRes = await pageB.evaluate(async (uid) => {
  const t = await chrome.tabs.get(uid).catch(() => null);
  return { stillOpen: !!t };
}, pageRtTabId);
const guardText = await wsSessionText(pageRtTabId);
check(
  "拒绝关闭用户的页面（只允许关自己开的）",
  guardRes.stillOpen && /不能关|只能关闭/.test(guardText),
  JSON.stringify({ stillOpen: guardRes.stillOpen, refused: /不能关|只能关闭/.test(guardText) })
);

await pageB.evaluate(() => {
  document.getElementById("input").value = "关掉新页";
  document.getElementById("sendBtn").click();
});
await sleep(2800);
const closedRes = await pageB.evaluate(async (id) => {
  const t = await chrome.tabs.get(id).catch(() => null);
  return { closed: !t };
}, newTabId);
check("可以关掉自己开的临时页", closedRes.closed, JSON.stringify(closedRes));

await pageB.evaluate(() => {
  window.__responder = null;
});
await pageRt.close().catch(() => {});
await sleep(2000); // 等 SW 清理：工作区里的页全关了 → 工作区消失

// ---------- ⑤ 关标签页 → 工作区消失 + 会话删除 ----------
// 注意：先按"工作区 id"过滤，跟历史里堆积的会话无关
const sessOfB = st.sessions.filter((s) => s.workspaceId === wsB.id).map((s) => s.id);
check("工作区 B 有自己的会话", sessOfB.length > 0, "sessions=" + sessOfB.length);

await pageA2.close().catch(() => {});
await sleep(1000);
st = await readState();
check(
  "关掉标签页后该工作区消失",
  st.workspaces.length === 1 && st.workspaces[0].id === wsA.id,
  JSON.stringify(st.workspaces.map((w) => w.id))
);
check(
  "工作区消失时它的会话被一并删除",
  !st.sessions.some((s) => sessOfB.includes(s.id)),
  JSON.stringify({ deleted: sessOfB })
);
check(
  "另一个工作区不受影响（仍在且会话保留）",
  st.workspaces.length === 1 && st.sessions.some((s) => s.workspaceId === wsA.id),
  JSON.stringify({ keptForA: st.sessions.filter((s) => s.workspaceId === wsA.id).length })
);

// ---------- ⑬ 工作区正在用的会话不能被裁掉（否则续跑会开新会话） ----------
// 放最后跑：它会灌一批"噪声会话"来把裁剪上限撑满，避免污染前面断言的输出。
const pinned = await pageB.evaluate(async () => {
  const mod = await import(chrome.runtime.getURL("lib/storage.js"));
  // 确定性地造一条"被工作区引用"的会话：先存会话，再把某个工作区记录指向它
  const s = mod.newSession("__pin_test__");
  s.title = "被引用的会话（不该被裁）";
  await mod.saveSession(s);
  const before = await chrome.storage.local.get(null);
  const key = Object.keys(before).find((k) => k.startsWith("ai_workspaces_"));
  if (!key) return { skipped: true, reason: "没有工作区记录" };
  const list = (before[key] && before[key].list) || [];
  list.push({
    id: "__pin_test_ws__",
    rootTabId: 999999,
    tabIds: [999999],
    sessionId: s.id,
    providerId: "x",
    modelId: "y",
    createdAt: Date.now(),
  });
  await chrome.storage.local.set({ [key]: { list } });
  // 灌 215 条噪声，把裁剪上限撑满
  for (let i = 0; i < 215; i++) {
    const n = mod.newSession("__noise__");
    n.title = "噪声 " + i;
    await mod.saveSession(n);
  }
  const after = (await chrome.storage.local.get(null)).ai_browser_sessions || [];
  return { kept: after.some((x) => x.id === s.id), total: after.length, heldId: s.id };
});
check(
  "工作区正在用的会话不会被历史裁剪掉",
  !pinned.skipped && pinned.kept,
  JSON.stringify(pinned.skipped ? pinned : { kept: pinned.kept, total: pinned.total })
);

// ---------- 汇总 ----------
const failed = results.filter((r) => !r.ok);
console.log(`\n===== 结果：${results.length - failed.length}/${results.length} 通过 =====`);
if (failed.length) console.log("失败项：" + failed.map((f) => f.name).join(" | "));

await browser.close();
server.close();
process.exit(failed.length ? 1 : 0);