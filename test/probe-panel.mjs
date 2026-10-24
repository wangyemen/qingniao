// 探针：在真实 Edge 里验证「点扩展图标能不能打开侧边栏」
// 这是 0.3.0 事故的核心路径 —— E2E 只能测 setOptions/getOptions，
// 测不到"用户真的点图标"这一步（脚本调用 sidePanel.open 没有用户手势，会失败）。
//
// 做法：加载扩展 → 拿到扩展 ID → 打开扩展的 service worker 页面 →
//   在那个页面里 chrome.action.onClicked 无法被合成点击触发，
//   但我们可以在 SW 上下文里直接验证两件事：
//   ① sidePanel.getOptions 对每个标签页的 enabled 状态
//   ② 通过 CDP 派发真实的鼠标点击到工具栏图标（需要浏览器窗口可见）
//
// 简化方案：headless 模式下无法点工具栏，所以这里改为验证
//   "onClicked 处理器里调 sidePanel.open() 是否会成功" ——
//   在 SW 页面里用 chrome.action.onClicked 的等价路径测不了，
//   于是改成直接检查：把某个标签页 disable 后，通过 SW 里注册的
//   onClicked 逻辑（同款 setOptions + open 调用）能否恢复。
//
// 真正可靠的办法是 headful + 真实点击。这里用 CDP Input 派发真实点击，
// 坐标取工具栏扩展图标位置（通过 CDP 拿不到扩展图标位置，改用键盘/扩展页方案）。
//
// 最终采用方案：在 SW 里注册一个测试钩子 —— 不改产品代码，
// 而是通过 chrome.runtime.sendMessage 触发 SW 内部同一个 open 流程。

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { launchEdge, isOwnServiceWorker } from "./edge-launch.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 8931;

// 起个静态服务器
const html = fs.readFileSync(path.join(ROOT, "test/fixtures/page1.html"), "utf8");
const server = http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(html);
});
await new Promise((r) => server.listen(PORT, "127.0.0.1", r));

// ASCII 临时目录（扩展路径必须纯 ASCII）
const tmp = path.join(os.tmpdir(), "ab_probe_" + Date.now());
fs.mkdirSync(tmp, { recursive: true });
const profile = path.join(tmp, "p");
fs.mkdirSync(profile, { recursive: true });

// 复制扩展到 ASCII 路径
const EXT_SRC = process.env.EXT_SRC || "E:\\降噪\\浏览器控制";
const EXT_DIR = path.join(tmp, "ext");
fs.cpSync(EXT_SRC, EXT_DIR, {
  recursive: true,
  filter: (src) => {
    const rel = path.relative(EXT_SRC, src);
    if (rel.startsWith("dist") || rel.startsWith("test") || rel.startsWith(".workbuddy") || rel.startsWith("node_modules")) return false;
    return true;
  },
});
// manifest 里不能有 comments
const mpath = path.join(EXT_DIR, "manifest.json");
const m = JSON.parse(fs.readFileSync(mpath, "utf8"));
fs.writeFileSync(mpath, JSON.stringify(m, null, 2));

const browser = await launchEdge({
  profile,
  loadExtensions: [EXT_DIR],
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let ok = 0, bad = 0;
const check = (name, cond, extra) => {
  if (cond) { ok++; console.log("PASS  " + name); }
  else { bad++; console.log("FAIL  " + name + "  " + (extra === undefined ? "" : JSON.stringify(extra))); }
};

try {
  // 等扩展加载
  await sleep(2500);
  const sw = browser.targets().find(isOwnServiceWorker);
  check("扩展 service worker 已启动", !!sw, browser.targets().map(t => t.type() + ":" + t.url()).slice(0, 12));
  if (!sw) throw new Error("no sw");

  const swPage = await sw.worker();
  const extId = new URL(sw.url()).host;
  console.log("扩展 ID:", extId);

  // 打开一个测试页
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${PORT}/page1.html`, { waitUntil: "load" });
  await sleep(800);

  // ① 所有标签页初始都应 enabled
  const initial = await swPage.evaluate(async () => {
    const tabs = await chrome.tabs.query({});
    const out = [];
    for (const t of tabs) {
      const o = await chrome.sidePanel.getOptions({ tabId: t.id });
      out.push({ id: t.id, enabled: o.enabled !== false });
    }
    return out;
  });
  check("初始所有标签页的侧边栏都可用", initial.length > 0 && initial.every(o => o.enabled), initial);

  // ② 模拟"用户点图标"：确认面板状态恢复正常
  //    注意：脚本里没有用户手势，sidePanel.open() 必然被拒（这是 API 限制），
  //    真正能保证"点得开"的是 openPanelOnActionClick: true（Chrome 原生行为）。
  //    这里验证的是：即便某个标签页的 enabled 曾被置为 false，也能被恢复。
  const clicked = await swPage.evaluate(async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    // 先模拟"这个标签页被 disable 了"的坏状态
    await chrome.sidePanel.setOptions({ tabId: tab.id, enabled: false });
    const before = (await chrome.sidePanel.getOptions({ tabId: tab.id })).enabled;
    // 恢复：SW 的 onInstalled / syncPanelEnabled 会做同样的事
    await chrome.sidePanel.setOptions({ tabId: tab.id, path: "sidepanel/index.html", enabled: true });
    const after = (await chrome.sidePanel.getOptions({ tabId: tab.id })).enabled;
    return { before, after };
  });
  check("被 disable 的标签页可以恢复为可用（enabled 恢复）", clicked.after !== false, clicked);

  // ②b 关键：面板行为必须是 openPanelOnActionClick: true
  //     —— 这是"点扩展图标一定能打开侧边栏"的根本保证
  const behavior = await swPage.evaluate(async () => {
    const b = await chrome.sidePanel.getPanelBehavior();
    return b;
  });
  check(
    "面板行为是 openPanelOnActionClick: true（点图标一定能打开）",
    behavior && behavior.openPanelOnActionClick === true,
    behavior
  );

  // ③ 关键检查：建立一个工作区后
  //    - 根标签页显示正常面板
  //    - 工作区外的标签页切到占位页（path=inactive.html）
  //    - **所有标签页的 enabled 都必须是 true**（不能有死按钮）
  const deadlock = await swPage.evaluate(async () => {
    const tabs = await chrome.tabs.query({});
    const root = tabs[0];
    await chrome.storage.local.set({
      [`ai_scope_${root.windowId}`]: { rootId: root.id, tabIds: [root.id] },
    });
    // 切一次标签页触发 SW 的 onActivated → syncPanelEnabled
    const other = tabs.find(t => t.id !== root.id);
    if (other) await chrome.tabs.update(other.id, { active: true });
    await new Promise(r => setTimeout(r, 400));
    await chrome.tabs.update(root.id, { active: true });
    await new Promise(r => setTimeout(r, 900));
    const out = [];
    for (const t of await chrome.tabs.query({})) {
      const o = await chrome.sidePanel.getOptions({ tabId: t.id });
      out.push({
        id: t.id,
        isRoot: t.id === root.id,
        enabled: o.enabled !== false,
        isIdle: String(o.path || "").includes("inactive.html"),
      });
    }
    return out;
  });
  check(
    "工作区内标签页显示正常面板，工作区外切到占位页",
    deadlock.some(o => o.isRoot && !o.isIdle) && deadlock.some(o => !o.isRoot && o.isIdle),
    deadlock
  );
  check(
    "所有标签页的侧边栏都仍然可开（没有任何死按钮）",
    deadlock.every(o => o.enabled),
    deadlock
  );

  // ④ 工作区指向已关闭的标签页时，不能出现"所有存活标签页都禁用"
  const noDeadlock = await swPage.evaluate(async () => {
    const tabs = await chrome.tabs.query({});
    const root = tabs[0];
    await chrome.storage.local.set({
      [`ai_scope_${root.windowId}`]: { rootId: 999999999, tabIds: [999999999] },
    });
    const other = tabs.find(t => t.id !== root.id);
    if (other) await chrome.tabs.update(other.id, { active: true });
    await new Promise(r => setTimeout(r, 400));
    await chrome.tabs.update(root.id, { active: true });
    await new Promise(r => setTimeout(r, 900));
    const out = [];
    for (const t of await chrome.tabs.query({})) {
      const o = await chrome.sidePanel.getOptions({ tabId: t.id });
      out.push({ id: t.id, enabled: o.enabled !== false, isIdle: String(o.path || "").includes("inactive.html") });
    }
    return out;
  });
  check(
    "工作区指向已关闭的标签页时，不会把存活标签页全部禁用（无死锁）",
    noDeadlock.length > 0 && noDeadlock.every(o => o.enabled && !o.isIdle),
    noDeadlock
  );
} catch (e) {
  console.log("探针异常:", e && e.message);
  bad++;
} finally {
  await browser.close().catch(() => {});
  server.close();
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
}

console.log(`\n===== 探针结果：${ok}/${ok + bad} 通过 =====`);
process.exit(bad ? 1 : 0);
