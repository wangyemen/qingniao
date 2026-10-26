// 0.4.4 三个"用户实际报过"的问题的复现与回归测试
//   ① 开了「自动执行」却还弹确认框；且确认框的"执行/取消"点了没反应
//   ② AI 自己开的标签页：切过去后侧栏显示"新对话"，而不是同一工作区共享的那份会话
//   ③ AI 报"找不到自己创建的标签页/标签页已关闭"，但其实它开着
//
// 关键背景：Chrome 侧栏是**每个标签页一份文档**，每份文档有自己的内存副本
// （设置勾选框、工作区列表、AI 开过的页集合）。不同步就会出上面这三条。
//
// 运行：node test/ws-multi.mjs

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { launchEdge } from "./edge-launch.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT = path.resolve(__dirname, "..");
const PORT = 8813;

let pass = 0,
  fail = 0;
const check = (name, ok, extra) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra !== undefined ? "  [" + extra + "]" : ""}`);
  ok ? pass++ : fail++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- 夹具页 ----------
const FIXTURE = (letter) => `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><title>夹具 ${letter}</title></head>
<body style="font-family:sans-serif;padding:20px">
  <h1>测试页 ${letter}</h1>
  <button id="b" aria-label="计数按钮">点我</button>
  <span id="n">0</span>
  <div id="rt" contenteditable="true" aria-label="正文编辑器" style="border:1px solid #ccc;min-height:60px"></div>
  <script>
    var c = 0;
    document.getElementById('b').addEventListener('click', function () {
      c++; document.getElementById('n').textContent = c; window.__clicks = c;
    });
    window.__clicks = 0;
  </script>
</body></html>`;

const NAMES = { "a.html": "A", "b.html": "B", "c.html": "C" };
const server = http.createServer((req, res) => {
  const name = path.basename(String(req.url || "").split("?")[0]);
  if (!NAMES[name]) {
    res.writeHead(404);
    res.end("not found");
    return;
  }
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(FIXTURE(NAMES[name]));
});
await new Promise((r) => server.listen(PORT, "127.0.0.1", r));

// ---------- 扩展 + 浏览器 ----------
const tmpExt = fs.mkdtempSync(path.join(os.tmpdir(), "qn-ext-"));
const tmpProfile = fs.mkdtempSync(path.join(os.tmpdir(), "qn-prof-"));
for (const item of ["manifest.json", "background", "content", "lib", "options", "sidepanel", "assets"]) {
  fs.cpSync(path.join(PROJECT, item), path.join(tmpExt, item), { recursive: true });
}
const browser = await launchEdge({ profile: tmpProfile, loadExtensions: [tmpExt] });

let extId = null;
for (let i = 0; i < 60 && !extId; i++) {
  for (const t of browser.targets()) {
    const u = t.url() || "";
    if (!u.includes("background/service-worker.js")) continue;
    const m = /^chrome-extension:\/\/([a-z]+)\//.exec(u);
    if (m) extId = m[1];
    break;
  }
  if (!extId) await sleep(300);
}
check("扩展已加载（service worker 存在）", !!extId, extId);

const FAKE_SETTINGS = {
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
};

// 假模型桩：只拦模型接口，其余（version.txt / 技能市场…）走真 fetch
function installStub() {
  window.__responder = null;
  const enc = new TextEncoder();
  const realFetch = window.fetch.bind(window);
  window.fetch = async (url, opts) => {
    const u = String(url || "");
    if (!/chat\/completions|\/models/i.test(u)) return realFetch(url, opts);
    let req = null;
    try {
      req = opts && typeof opts.body === "string" ? JSON.parse(opts.body) : null;
    } catch (_) {}
    let deltas = [{ content: "好的。" }];
    try {
      if (typeof window.__responder === "function") deltas = window.__responder(req) || deltas;
    } catch (e) {
      deltas = [{ content: "桩出错：" + String(e && e.message) }];
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
              return { done: false, value: enc.encode("data: " + JSON.stringify({ choices: [{ delta: deltas[i++] }] }) + "\n\n") };
            },
          };
        },
      },
    };
  };
}

const ERRORS = [];
async function openPanel(frontPage) {
  const p = await browser.newPage();
  p.on("pageerror", (e) => ERRORS.push(String(e).slice(0, 160)));
  await p.evaluateOnNewDocument(installStub);
  await p.goto(`chrome-extension://${extId}/sidepanel/index.html`, { waitUntil: "load", timeout: 20000 });
  await p.waitForSelector("#sendBtn", { timeout: 10000 });
  if (frontPage) await frontPage.bringToFront(); // 面板自己是标签页，别让它顶在最前
  await sleep(700);
  return p;
}

async function openPage(name) {
  const p = await browser.newPage();
  await p.goto(`http://127.0.0.1:${PORT}/${name}`, { waitUntil: "load" });
  await sleep(400);
  return p;
}

// 可序列化的应答规则：按"最后一条用户消息"匹配
// 注意：调用处传的是 { rules: [...] }，这里**整包**交给页面（别再包一层，会变成 spec.rules.rules）
async function script(panel, spec) {
  await panel.evaluate((cfg) => {
    window.__responder = (req) => {
      const msgs = (req && req.messages) || [];
      const all = msgs.map((m) => (typeof m.content === "string" ? m.content : "")).join("\n");
      if (all.includes("系统自动唤醒")) return [{ content: "已继续。" }];
      let lastUser = "";
      for (let i = msgs.length - 1; i >= 0; i--) {
        const m = msgs[i];
        if (m && m.role === "user" && !m.isActionResult && typeof m.content === "string" && m.content) {
          lastUser = m.content;
          break;
        }
      }
      const rule = cfg.rules.find((r) => lastUser.includes(r.when));
      if (!rule) return [{ content: "好的。" }];
      const flag = "__did_" + rule.when;
      if (rule.once && window[flag]) return [{ content: "已经做过了。" }];
      if (rule.once) window[flag] = true;
      if (rule.click) {
        const m = new RegExp("\\[(\\d+)\\][^\\n]*" + rule.click).exec(all);
        return [{ content: "好。\n```action\n" + JSON.stringify({ action: "click", target: m ? Number(m[1]) : 0 }) + "\n```" }];
      }
      if (rule.tabAction) {
        return [{ content: "好。\n```action\n" + JSON.stringify({ action: rule.tabAction, tab: window.__targetTab }) + "\n```" }];
      }
      if (rule.newtab) {
        return [{ content: "好。\n```action\n" + JSON.stringify({ action: "newtab", url: rule.newtab }) + "\n```" }];
      }
      return [{ content: rule.text || "好的。" }];
    };
  }, spec);
}

const say = async (panel, text, front) => {
  if (front) await front.bringToFront();
  await panel.evaluate((t) => {
    document.getElementById("input").value = t;
    document.getElementById("sendBtn").click();
  }, text);
};

// 按 URL 找已存在的标签页（用来拿"AI 开的那一页"，而不是自己新开一个）
async function pageForUrl(part, tries = 30) {
  for (let i = 0; i < tries; i++) {
    for (const p of await browser.pages()) {
      const u = p.url() || "";
      if (u.includes(part) && !u.startsWith("chrome-extension://")) return p;
    }
    await sleep(300);
  }
  return null;
}

const storeWorkspaces = (panel) =>
  panel.evaluate(async () => {
    const all = await chrome.storage.local.get(null);
    const keys = Object.keys(all).filter((k) => k.startsWith("ai_workspaces_"));
    const out = [];
    for (const k of keys) for (const w of (all[k] || {}).list || []) out.push({ id: w.id, tabIds: w.tabIds || [], aiTabs: w.aiTabs || [], sessionId: w.sessionId });
    return out;
  });

const sessionText = (panel) =>
  panel.evaluate(async () => {
    const all = await chrome.storage.local.get(null);
    const keys = Object.keys(all).filter((k) => k.startsWith("ai_workspaces_"));
    const [cur] = await chrome.tabs.query({ active: true, currentWindow: true });
    let sessId = null;
    for (const k of keys) for (const w of (all[k] || {}).list || []) if ((w.tabIds || []).includes(cur.id)) sessId = w.sessionId;
    const s = (all.ai_browser_sessions || []).find((x) => x.id === sessId);
    return { sessId, text: ((s && s.messages) || []).map((m) => (typeof m.content === "string" ? m.content : "")).join("\n―\n"), activeTab: cur && cur.id };
  });

try {
  // ---------- 起点：种子设置 + 干净存储 ----------
  const pageA = await openPage("a.html");
  const seedPanel = await openPanel(pageA);
  await seedPanel.evaluate(async (s) => {
    await chrome.storage.local.set({ ai_browser_settings: s });
    const all = await chrome.storage.local.get(null);
    const keys = Object.keys(all).filter((k) => k.startsWith("ai_workspaces_"));
    if (keys.length) await chrome.storage.local.remove(keys);
    await chrome.storage.local.remove("ai_browser_sessions");
  }, FAKE_SETTINGS);
  await seedPanel.reload({ waitUntil: "load" });
  await pageA.bringToFront();
  await sleep(900);

  // ============ ① 关闭自动执行 → 确认框的按钮必须真的能用 ============
  await script(seedPanel, { rules: [{ when: "点一下", click: "「计数按钮」" }] });
  await say(seedPanel, "点一下那个按钮", pageA);
  await sleep(1800);

  const pending = await seedPanel.evaluate(() => {
    const card = document.querySelector(".tool-card.pending");
    return {
      hasCard: !!card,
      hasOk: !!(card && card.querySelector(".ok-btn")),
      hasCancel: !!(card && card.querySelector(".cancel-btn")),
      autoChecked: document.getElementById("autoToggle").checked,
    };
  });
  check("关闭自动执行后确实弹出确认框（执行/取消都在）", pending.hasCard && pending.hasOk && pending.hasCancel, JSON.stringify(pending));

  const clicks0 = await pageA.evaluate(() => window.__clicks || 0);
  await seedPanel.evaluate(() => {
    const c = document.querySelector(".tool-card.pending");
    if (c) c.querySelector(".ok-btn").click();
  });
  await sleep(1600);
  const clicks1 = await pageA.evaluate(() => window.__clicks || 0);
  check("点「执行」真的执行了（页面被点击）", clicks1 > clicks0, `before=${clicks0} after=${clicks1}`);

  await say(seedPanel, "点一下那个按钮", pageA);
  await sleep(1700);
  const clicks2 = await pageA.evaluate(() => window.__clicks || 0);
  await seedPanel.evaluate(() => {
    const c = document.querySelector(".tool-card.pending");
    if (c) c.querySelector(".cancel-btn").click();
  });
  await sleep(1300);
  const clicks3 = await pageA.evaluate(() => window.__clicks || 0);
  check("点「取消」真的不执行", clicks3 === clicks2, `before=${clicks2} after=${clicks3}`);

  // ---- 卡片被重建后（renderSession）按钮仍然要能点 ----
  await say(seedPanel, "点一下那个按钮", pageA);
  await sleep(1700);
  const rebuilt = await seedPanel.evaluate(() => {
    const card = document.querySelector(".tool-card.pending");
    if (!card) return { ok: false, why: "没有待确认卡片" };
    return { ok: true, wsId: card.dataset.wsId || "" };
  });
  check("待确认卡片带上了工作区标记（委托需要）", rebuilt.ok && !!rebuilt.wsId, JSON.stringify(rebuilt));

  // 模拟"切标签页导致消息列表重建"，再点执行 —— 必须仍然生效
  // （用真实的路径：切到别的页 → 再切回来，refreshActive 会 activateWorkspace → renderSession）
  const pageA2 = await openPage("a.html");
  await pageA2.bringToFront();
  await sleep(800);
  await pageA.bringToFront();
  await sleep(1000);
  const clicksR0 = await pageA.evaluate(() => window.__clicks || 0);
  const rebuiltCard = await seedPanel.evaluate(() => {
    const card = document.querySelector(".tool-card.pending");
    return { has: !!card, wsId: card ? card.dataset.wsId || "" : "" };
  });
  check("切页回来后待确认卡片仍在（且带工作区标记）", rebuiltCard.has && !!rebuiltCard.wsId, JSON.stringify(rebuiltCard));
  await seedPanel.evaluate(() => {
    const card = document.querySelector(".tool-card.pending");
    if (card) card.querySelector(".ok-btn").click();
  });
  await sleep(1600);
  const clicksR1 = await pageA.evaluate(() => window.__clicks || 0);
  check("切页重建后点「执行」仍然生效", clicksR1 > clicksR0, `before=${clicksR0} after=${clicksR1}`);

  // ============ ①b 在 A 面板打开自动执行 → B 面板不该再弹确认框 ============
  await seedPanel.evaluate(async () => {
    const all = await chrome.storage.local.get(null);
    const s = all.ai_browser_settings || {};
    s.autoExecute = true;
    await chrome.storage.local.set({ ai_browser_settings: s });
  });
  await sleep(700);

  const pageB = await openPage("b.html");
  const panelB = await openPanel(pageB);
  const bToggle = await panelB.evaluate(() => ({ checked: document.getElementById("autoToggle").checked }));
  check("另一份侧栏文档同步到了「自动执行」勾选", bToggle.checked === true, JSON.stringify(bToggle));

  await script(panelB, { rules: [{ when: "点一下", click: "「计数按钮」" }] });
  await say(panelB, "点一下那个按钮", pageB);
  await sleep(600);
  const bPending = await panelB.evaluate(() => !!document.querySelector(".tool-card.pending"));
  await sleep(1500);
  const bClicks = await pageB.evaluate(() => window.__clicks || 0);
  check("开了自动执行后不弹确认框、直接执行", !bPending && bClicks > 0, JSON.stringify({ pending: bPending, clicks: bClicks }));

  // ============ ② AI 开的新页：另一份面板实例切过去要看到"同一份会话" ============
  await script(seedPanel, { rules: [{ when: "开个新页", newtab: `http://127.0.0.1:${PORT}/c.html`, once: true }] });
  await say(seedPanel, "开个新页去查点东西", pageA);
  await sleep(4500);

  const wsAfter = await storeWorkspaces(seedPanel);
  const aiTabId = await seedPanel.evaluate(async () => {
    const all = await chrome.storage.local.get(null);
    const keys = Object.keys(all).filter((k) => k.startsWith("ai_workspaces_"));
    for (const k of keys) for (const w of (all[k] || {}).list || []) if ((w.aiTabs || []).length) return w.aiTabs[w.aiTabs.length - 1];
    return 0;
  });
  check(
    "AI 新开的页已并入工作区并落盘（aiTabs）",
    aiTabId > 0 && wsAfter.some((w) => (w.tabIds || []).includes(aiTabId)),
    JSON.stringify({ aiTabId, ws: wsAfter.map((w) => ({ t: w.tabIds, ai: w.aiTabs })) })
  );

  // 用户手动切到 AI 开的那一页 → 那份侧栏文档应当显示同一份会话（而不是新对话）
  // ⚠️ 别另开一个 c.html：那样活动标签页会变成"我自己开的那个"，而不是 AI 开的那个。
  //    这里要的就是"AI 开的那一页"，用 browser.pages() 找它。
  const pageC = await pageForUrl("/c.html");
  check("能找到 AI 开的那一页（标签页真的存在）", !!pageC, pageC ? pageC.url() : "没找到");
  await pageC.bringToFront();
  await sleep(600);
  const panelC = await openPanel(pageC);
  await pageC.bringToFront();
  await sleep(1800);

  const cView = await panelC.evaluate(() => {
    const empty = document.querySelector(".empty-hint");
    return { emptyVisible: !!empty && getComputedStyle(empty).display !== "none" };
  });
  check("切到 AI 开的页：不是「新对话」空态", !cView.emptyVisible, JSON.stringify(cView));

  const cState = await sessionText(panelC);
  check("那一页面板显示的是同一份会话（有历史消息）", !!cState.sessId && cState.text.length > 20, JSON.stringify({ sessId: cState.sessId, len: cState.text.length }));

  // ============ ③ 在新实例里操作/关闭 AI 开的页 ============
  await panelC.evaluate((id) => {
    window.__targetTab = id;
  }, aiTabId);
  await script(panelC, { rules: [{ when: "读一下那页", tabAction: "extract" }] });
  await say(panelC, "读一下那页", pageC);
  await sleep(3000);
  const cActed = await sessionText(panelC);
  check("在新实例里带 tab 操作 AI 开的页：不报「已关闭」", !/找不到标签页|已经关闭|不在本工作区/.test(cActed.text), JSON.stringify({ tail: cActed.text.slice(-160) }));

  // ============ ④ 同步显示：任一页发消息/AI 回复，同一工作区的所有页都看得到 ============
  // （放在关掉临时页之前 —— 关了以后活动页就不属于工作区了，读会话就没意义）
  const beforeReply = await sessionText(panelC);
  await script(seedPanel, { rules: [{ when: "写一句话", text: "这是我给的回复。" }] });
  await say(seedPanel, "写一句话", pageA);
  await sleep(2500);
  await pageC.bringToFront(); // 回到 AI 开的页看它的那份文档
  await sleep(800);
  const afterReply = await sessionText(panelC);
  check(
    "AI 的新回复写进了同一份会话（各页共享）",
    /这是我给的回复/.test(afterReply.text) && afterReply.text.length > beforeReply.text.length,
    JSON.stringify({ before: beforeReply.text.length, after: afterReply.text.length })
  );

  // ============ ③b 用完关掉：另一份实例里也能关 ============
  await panelC.evaluate((id) => {
    window.__targetTab = id;
  }, aiTabId);
  await script(panelC, { rules: [{ when: "用完关掉", tabAction: "closetab" }] });
  await say(panelC, "用完关掉", pageC);
  await sleep(2800);
  const stillOpen = await panelC.evaluate(async (id) => !!(await chrome.tabs.get(id).catch(() => null)), aiTabId);
  check("另一份实例里也能关掉 AI 自己开的临时页", !stillOpen, JSON.stringify({ stillOpen }));

  // ============ ⑤ 并入 / 移出工作区：视图要跟着变 ============
  // 并入 → 这一页的会话立刻变成那个工作区的会话（同一份，含历史）
  // 移出 → 这一页换回"自己的新对话"页
  await pageA.bringToFront();
  await sleep(600);
  const wsA = (await storeWorkspaces(seedPanel)).find((w) => (w.tabIds || []).length && w.sessionId);
  check("有一个可并入的工作区", !!wsA, JSON.stringify(wsA));

  // 打开一个新页（未归属），把它的面板并入 wsA
  const pageD = await openPage("b.html");
  const panelD = await openPanel(pageD);
  await pageD.bringToFront();
  await sleep(900);

  const beforeMerge = await panelD.evaluate(() => ({
    empty: (() => {
      const e = document.querySelector(".empty-hint");
      return !!e && getComputedStyle(e).display !== "none";
    })(),
    mergeBtn: !!document.querySelector("#mergeBar button, #mergeBar .tiny"),
  }));
  check("新页初始是它自己的空对话（有并入入口）", beforeMerge.empty && beforeMerge.mergeBtn, JSON.stringify(beforeMerge));

  // 点"并入已有工作区（N）"展开 → 再点具体那个工作区
  // （第一颗按钮只是展开列表，真正并入的是展开出来的 chip —— 别点错）
  await panelD.evaluate(() => {
    const t = [...document.querySelectorAll("#mergeBar button")].find((b) => /并入已有工作区/.test(b.textContent));
    if (t) t.click();
  });
  await sleep(500);
  const chipText = await panelD.evaluate(() => {
    const chips = [...document.querySelectorAll("#mergeBar button")].filter(
      (b) => !/并入已有工作区|取消/.test(b.textContent)
    );
    if (chips.length) {
      const t = chips[0].textContent;
      chips[0].click();
      return t;
    }
    return "";
  });
  check("展开后有可点的工作区 chip", !!chipText, chipText);
  await sleep(1800);
  const afterMerge = await panelD.evaluate(() => {
    const e = document.querySelector(".empty-hint");
    const msgs = document.querySelectorAll(".msg").length;
    return { empty: !!e && getComputedStyle(e).display !== "none", msgs };
  });
  check("并入后：会话变成那个工作区的会话（不是空对话）", !afterMerge.empty, JSON.stringify(afterMerge));

  // 移出 → 回到自己的新对话页
  await panelD.evaluate(() => {
    const out = [...document.querySelectorAll("#mergeBar button, .wsbar button, button")].find((b) => /移出/.test(b.textContent));
    if (out) out.click();
  });
  await sleep(1500);
  const afterEject = await panelD.evaluate(() => {
    const e = document.querySelector(".empty-hint");
    return { empty: !!e && getComputedStyle(e).display !== "none" };
  });
  check("移出后：回到自己的新对话页", afterEject.empty, JSON.stringify(afterEject));

  if (ERRORS.length) console.log("[面板报错] " + ERRORS.slice(0, 4).join(" | "));
  check("面板没有抛异常", ERRORS.length === 0, `${ERRORS.length} 条`);
} finally {
  await browser.close().catch(() => {});
  server.close();
  fs.rmSync(tmpExt, { recursive: true, force: true });
  fs.rmSync(tmpProfile, { recursive: true, force: true });
}

console.log(`\n===== 多页/多实例：${pass}/${pass + fail} 通过 =====`);
process.exit(fail ? 1 : 0);