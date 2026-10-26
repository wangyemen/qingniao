// "刁钻编辑器 / 复杂页面"的端到端测试
//
// 用户反馈：富文本编辑器的点击与输入时好时坏；有些网站试很多轮都不成；
// 有时候一开始成功、后面"迷失方向"又不成了。怀疑不只编辑器，复杂页面浏览也有问题。
//
// 这里用 test/fixtures/page12.html 造四类真实难点，验证扩展能不能稳定搞定：
//   ① 只认"真人点击才建选区"、且输入后整个重建 DOM 的编辑器（ProseMirror 一类）
//   ② Shadow DOM 里的按钮 / 输入框
//   ③ 同源 iframe 里的按钮
//   ④ 虚拟列表（只有滚到附近的行才在 DOM 里）
//
// 运行：node test/tough-pages.mjs

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { launchEdge } from "./edge-launch.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT = path.resolve(__dirname, "..");
const PORT = 8815;

let pass = 0,
  fail = 0;
const check = (name, ok, extra) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra !== undefined ? "  [" + extra + "]" : ""}`);
  ok ? pass++ : fail++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const FIXTURE = fs.readFileSync(path.join(PROJECT, "test/fixtures/page12.html"), "utf8");
const server = http.createServer((req, res) => {
  const name = path.basename(String(req.url || "").split("?")[0]);
  if (name !== "tough.html") {
    res.writeHead(404);
    res.end("not found");
    return;
  }
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(FIXTURE);
});
await new Promise((r) => server.listen(PORT, "127.0.0.1", r));

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
check("扩展已加载", !!extId, extId);

const FAKE_SETTINGS = {
  providers: [
    {
      id: "fake",
      name: "Fake",
      baseUrl: "http://127.0.0.1:9/v1",
      models: [{ id: "fake-1", label: "Fake 1", vision: false }],
      keys: [{ id: "k1", label: "K1", value: "sk-test", enabled: true }],
    },
  ],
  activeProviderId: "fake",
  activeModelId: "fake-1",
  contextEnabled: true,
  thinkingEnabled: false,
  controlEnabled: true,
  autoExecute: true, // 自动执行，专测"动作链路"本身
};

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

try {
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${PORT}/tough.html`, { waitUntil: "load" });
  const panel = await browser.newPage();
  await panel.evaluateOnNewDocument(installStub);
  await panel.goto(`chrome-extension://${extId}/sidepanel/index.html`, { waitUntil: "load", timeout: 20000 });
  await panel.waitForSelector("#sendBtn", { timeout: 10000 });
  await panel.evaluate(async (s) => {
    await chrome.storage.local.set({ ai_browser_settings: s });
    const all = await chrome.storage.local.get(null);
    const keys = Object.keys(all).filter((k) => k.startsWith("ai_workspaces_"));
    if (keys.length) await chrome.storage.local.remove(keys);
    await chrome.storage.local.remove("ai_browser_sessions");
  }, FAKE_SETTINGS);
  await panel.reload({ waitUntil: "load" });
  await page.bringToFront();
  await sleep(900);

  // 忙时点发送 = 点"停止"！每次都等面板空闲再发下一条
  async function waitIdle(tries = 60) {
    for (let i = 0; i < tries; i++) {
      const busy = await panel.evaluate(() => document.getElementById("sendBtn").classList.contains("streaming"));
      if (!busy) return true;
      await sleep(300);
    }
    return false;
  }

  // 让 AI 按脚本动作；动作里用"从元素列表里找到的编号"
  async function run(plan) {
    await waitIdle();
    await panel.evaluate((spec) => {
      window.__step = 0;
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
        if (!lastUser.includes(spec.go) && !(all.includes("【动作执行结果】") && all.includes(spec.go))) {
          return [{ content: "好的。" }];
        }
        const act = spec.steps[window.__step];
        if (!act) return [{ content: "步骤走完了。" }];
        window.__step++;
        // 可以用 all（元素列表）里的文字定位编号
        let target = act.target;
        if (act.findText) {
          const re = new RegExp("\\[(\\d+)\\][^\\n]*" + act.findText);
          const m = re.exec(all);
          target = m ? Number(m[1]) : 0;
        }
        const obj = { action: act.action, target, value: act.value, text: act.text, key: act.key, human: act.human };
        Object.keys(obj).forEach((k) => obj[k] === undefined && delete obj[k]);
        return [{ content: "好。\n```action\n" + JSON.stringify(obj) + "\n```" }];
      };
    }, plan);
    await page.bringToFront();
    await panel.evaluate((t) => {
      document.getElementById("input").value = t;
      document.getElementById("sendBtn").click();
    }, plan.go);
  }

  const lastResult = () =>
    panel.evaluate(async () => {
      const all = await chrome.storage.local.get(null);
      const s = (all.ai_browser_sessions || [])[0];
      const txt = ((s && s.messages) || []).map((m) => (typeof m.content === "string" ? m.content : "")).join("\n");
      const parts = txt.split("【动作执行结果】");
      return parts.slice(-2).join("  ||  ").slice(0, 700);
    });

  // ---------- ① 刁钻编辑器 ----------
  // 一：AI 只用 fill（不先 click）—— 现在扩展会**自己先真点一下**，应能成功
  await run({
    go: "写进编辑器",
    steps: [
      { action: "fill", findText: "「正文编辑器」", value: "第一行\n第二行" },
    ],
  });
  await sleep(3200);
  const ed1 = await page.evaluate(() => ({
    text: window.__editor.text,
    lines: window.__editor.lines,
    focused: window.__editor.focused,
    rebuilds: window.__editor.rebuilds,
  }));
  const r1 = await lastResult();
  check("① 刁钻编辑器：fill 能写进去（扩展自动先真点击建选区）", ed1.lines >= 2 && /第一行/.test(ed1.text), JSON.stringify({ ...ed1, tail: r1.slice(0, 120) }));
  check("① 编辑器确实发生了 DOM 重建（模拟真实重渲染）", ed1.rebuilds > 1, `rebuilds=${ed1.rebuilds}`);

  // 二：再来一次（换内容）—— 验证"重建后仍能写入"，不是撞运气
  await page.evaluate(() => window.__editor.reset());
  await sleep(200);
  await run({
    go: "再写一次",
    steps: [{ action: "fill", findText: "「正文编辑器」", value: "甲\n乙\n丙" }],
  });
  await sleep(3200);
  const ed2 = await page.evaluate(() => ({ lines: window.__editor.lines, text: window.__editor.text }));
  check("① 第二次仍然成功（不是撞运气）", ed2.lines >= 3 && /丙/.test(ed2.text), JSON.stringify(ed2));

  // ---------- ② Shadow DOM ----------
  await run({
    go: "点影子按钮",
    steps: [{ action: "click", findText: "「影子按钮」" }],
  });
  await sleep(3000);
  const sh = await page.evaluate(() => window.__shadowClicks());
  check("② Shadow DOM 里的按钮能点到", sh > 0, `clicks=${sh}`);

  // ---------- ③ 同源 iframe ----------
  await run({
    go: "点框架按钮",
    steps: [{ action: "click", findText: "「框架内按钮」" }],
  });
  await sleep(3000);
  const fr = await page.evaluate(() => window.__frameClicks || 0);
  check("③ 同源 iframe 里的按钮能点到", fr > 0, `clicks=${fr}`);

  // 先验证"滚动能让虚拟列表换一批行"
  await run({
    go: "滚到下面看看",
    steps: [
      { action: "scroll", value: "down" },
      { action: "scroll", value: "down" },
    ],
  });
  await sleep(2600);
  const scrolled = await page.evaluate(() => {
    const l = document.getElementById("vlist");
    return { top: l.scrollTop, rendered: window.__virtual.rendered() };
  });
  check("④ 滚动后虚拟列表渲染出不同的行（滚动生效）", scrolled.top > 0 && scrolled.rendered > 0, JSON.stringify(scrolled));

  // 目标条目在列表顶部（第 2 行）：**不滚回顶部它根本不在 DOM 里** ——
  // 这正是虚拟列表的难点，也是"复杂页面看不见元素"的典型原因
  await page.evaluate(() => {
    document.getElementById("vlist").scrollTop = 0;
  });
  await sleep(800);
  const backTop = await page.evaluate(() => ({
    rendered: window.__virtual.rendered(),
    hasTarget: !!document.querySelector('[aria-label="目标条目"]'),
  }));
  check("④ 滚回顶部后目标条目才出现在 DOM 里（虚拟列表特性）", backTop.hasTarget, JSON.stringify(backTop));

  await run({
    go: "点目标条目",
    steps: [
      // act 不会"按文字"找元素（那是 find 的活）——先 find 拿到编号，再点它
      { action: "find", text: "目标条目" },
      { action: "click", findText: "「目标条目」" },
    ],
  });
  await sleep(3400);
  const hit = await page.evaluate(() => window.__hitTarget || 0);
  const r4 = await lastResult();
  const tail4 = await panel.evaluate(async () => {
    const all = await chrome.storage.local.get(null);
    const s = (all.ai_browser_sessions || [])[0];
    const msgs = (s && s.messages) || [];
    return msgs
      .slice(-6)
      .map((m) => `${m.role}${m.isActionResult ? "(结果)" : ""}: ${String(m.content || "").slice(0, 120)}`)
      .join("\n");
  });
  check("④ 虚拟列表里滚出来的目标条目能点到（按文字找）", hit > 0, JSON.stringify({ hit, tail4, tail: r4.slice(0, 140) }));

  const errs = await panel.evaluate(() => window.__errs || []);
  check("面板没有抛异常", !errs.length, `${errs.length} 条`);
} finally {
  await browser.close().catch(() => {});
  server.close();
  fs.rmSync(tmpExt, { recursive: true, force: true });
  fs.rmSync(tmpProfile, { recursive: true, force: true });
}

console.log(`\n===== 刁钻页面：${pass}/${pass + fail} 通过 =====`);
process.exit(fail ? 1 : 0);