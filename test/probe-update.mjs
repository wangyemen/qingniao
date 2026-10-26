// 探针：验证「自动更新 + 数据不丢」这条路的可行性 —— 只做事实测量，不改产品代码。
//
// 要回答四个问题：
//   ① 扩展页里有没有 File System Access API？（= 扩展能不能"自己写自己的文件"）
//   ② 磁盘上的文件被换掉后，正在运行的扩展读 getURL 拿到的是新文件还是旧缓存？
//      （= 能不能自己发现"磁盘上已经是新版，该 reload 了"）
//   ③ chrome.runtime.reload() 能不能把换上去的新文件真正加载进来（运行时版本号变化），
//      并且 chrome.storage.local 里的数据还在不在？（= 更新后数据保留）
//   ④ 两个侧栏同时写会话时，现在的"整块读-改-写"会不会真的丢消息？
//
// 运行：node test/probe-update.mjs

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { launchEdge, isOwnServiceWorker } from "./edge-launch.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let ok = 0;
let bad = 0;
const check = (name, cond, extra) => {
  if (cond) {
    ok++;
    console.log("PASS  " + name + (extra === undefined ? "" : "  " + JSON.stringify(extra)));
  } else {
    bad++;
    console.log("FAIL  " + name + (extra === undefined ? "" : "  " + JSON.stringify(extra)));
  }
};

// ASCII 临时目录（--load-extension 的路径必须纯 ASCII）
const tmp = path.join(os.tmpdir(), "qn_probe_upd_" + Date.now());
fs.mkdirSync(tmp, { recursive: true });
const profile = path.join(tmp, "p");
const EXT_DIR = path.join(tmp, "ext");
const SKIP = new Set([".git", ".workbuddy", "dist", "test", "docs", "node_modules", "qingniao.gt.tc"]);
fs.cpSync(ROOT, EXT_DIR, {
  recursive: true,
  filter: (src) => {
    const rel = path.relative(ROOT, src);
    if (!rel) return true;
    return !SKIP.has(rel.split(path.sep)[0]);
  },
});
// manifest 必须是合法 JSON（仓库里那份也是）
const MANIFEST_PATH = path.join(EXT_DIR, "manifest.json");
const VERSION_TXT_PATH = path.join(EXT_DIR, "version.txt");
const STAGED_VERSION = "9.9.9";

console.log("临时扩展目录:", EXT_DIR);
const browser = await launchEdge({ profile, loadExtensions: [EXT_DIR] });

const panelUrl = (id) => `chrome-extension://${id}/sidepanel/index.html`;

/** 等我们自己的 service worker 出现，返回 { extId, sw } */
async function waitForExt(timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const sw = browser.targets().find(isOwnServiceWorker);
    if (sw && sw.url()) return { extId: new URL(sw.url()).host, sw };
    await sleep(250);
  }
  return { extId: null, sw: null };
}

try {
  // ---------- 0. 扩展加载 ----------
  let { extId, sw } = await waitForExt();
  check("扩展已加载（service worker 在）", !!extId, extId);
  if (!extId) throw new Error("no service worker target");

  const page = await browser.newPage();
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(String(e).slice(0, 200)));
  await page.goto(panelUrl(extId), { waitUntil: "load", timeout: 20000 });
  await sleep(600);

  // ---------- ① 能力探测 ----------
  const cap = await page.evaluate(() => ({
    showDirectoryPicker: typeof window.showDirectoryPicker,
    showOpenFilePicker: typeof window.showOpenFilePicker,
    showSaveFilePicker: typeof window.showSaveFilePicker,
    runtimeReload: typeof chrome.runtime.reload,
    manifestVersion: chrome.runtime.getManifest().version,
    extId: chrome.runtime.id,
  }));
  console.log("能力探测:", JSON.stringify(cap));
  check("扩展页里 chrome.runtime.reload 可用（= 能让自己重新加载）", cap.runtimeReload === "function");
  check(
    "扩展页里有 File System Access API（= 可能自己写自己的文件）",
    cap.showDirectoryPicker === "function",
    { dir: cap.showDirectoryPicker, save: cap.showSaveFilePicker }
  );

  // ---------- ② 磁盘换版后，运行中的扩展读到什么 ----------
  const token = "tk-" + Math.random().toString(36).slice(2, 10);
  await page.evaluate((t) => chrome.storage.local.set({ __probe_token: t }), token);

  // 假装"伴侣程序/更新器"把新版本铺到了磁盘上
  const mf = JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8"));
  const oldVersion = mf.version;
  mf.version = STAGED_VERSION;
  fs.writeFileSync(MANIFEST_PATH, JSON.stringify(mf, null, 2));
  const vtRaw = fs.readFileSync(VERSION_TXT_PATH, "utf8");
  fs.writeFileSync(VERSION_TXT_PATH, vtRaw.replace(/^latest:\s*.*$/m, "latest: " + STAGED_VERSION));
  fs.writeFileSync(path.join(EXT_DIR, "staged-marker.txt"), "staged by probe\n");

  const seen = await page.evaluate(async () => {
    const out = { running: chrome.runtime.getManifest().version };
    const grab = async (opts) => {
      try {
        const res = await fetch(chrome.runtime.getURL("version.txt"), opts);
        const text = await res.text();
        const m = /^latest\s*:\s*(.+)$/m.exec(text);
        return m ? m[1].trim() : "(no latest)";
      } catch (e) {
        return "ERR " + e.message;
      }
    };
    out.versionTxtDefault = await grab(undefined);
    out.versionTxtNoCache = await grab({ cache: "no-cache" });
    try {
      const r = await fetch(chrome.runtime.getURL("staged-marker.txt"));
      out.newFileVisible = r.ok ? (await r.text()).trim() : "HTTP " + r.status;
    } catch (e) {
      out.newFileVisible = "ERR " + e.message;
    }
    return out;
  });
  console.log("磁盘换版后（运行中）:", JSON.stringify(seen));
  check("运行中的扩展仍是旧版本（reload 前不会自己变）", seen.running === oldVersion, {
    running: seen.running,
    oldVersion,
  });
  check(
    "扩展能读到磁盘上的新版 version.txt（= 可自己发现该更新了）",
    seen.versionTxtDefault === STAGED_VERSION || seen.versionTxtNoCache === STAGED_VERSION,
    seen
  );

  // ---------- ④ 会话"整块读-改-写"的并发丢数据测试（在 reload 前做）----------
  const page2 = await browser.newPage();
  await page2.goto(panelUrl(extId), { waitUntil: "load", timeout: 20000 });
  await sleep(400);

  const writeSession = (p, id) =>
    p.evaluate(
      (sid) =>
        import("/lib/storage.js").then((m) =>
          m.saveSession({
            id: sid,
            title: sid,
            createdAt: Date.now(),
            updatedAt: Date.now(),
            workspaceId: null,
            messages: [{ role: "user", content: sid }],
          })
        ),
      id
    );

  const readIds = () =>
    page.evaluate(() =>
      import("/lib/storage.js").then((m) => m.listSessions().then((l) => l.map((s) => s.id)))
    );

  const ROUNDS = 8;
  let lost = 0;
  const detail = [];
  for (let i = 0; i < ROUNDS; i++) {
    await page.evaluate(() => chrome.storage.local.remove("ai_browser_sessions"));
    await Promise.all([writeSession(page, "A" + i), writeSession(page2, "B" + i)]);
    const ids = await readIds();
    const both = ids.includes("A" + i) && ids.includes("B" + i);
    if (!both) lost++;
    detail.push({ round: i, kept: ids.length, both });
  }
  check(`两个侧栏【同时】保存会话，没有一条被覆盖（${ROUNDS} 轮）`, lost === 0, {
    lostRounds: lost,
    detail,
  });

  // 对照组：错开 80ms 再写 → 应该都保住（说明风险来自"同时"，不是存储本身丢）
  let lostStaggered = 0;
  const ROUNDS2 = 6;
  for (let i = 0; i < ROUNDS2; i++) {
    await page.evaluate(() => chrome.storage.local.remove("ai_browser_sessions"));
    await writeSession(page, "S" + i);
    await sleep(80);
    await writeSession(page2, "T" + i);
    const ids = await readIds();
    if (!(ids.includes("S" + i) && ids.includes("T" + i))) lostStaggered++;
  }
  check(`两个侧栏错开 80ms 保存会话（对照组，${ROUNDS2} 轮）`, lostStaggered === 0, {
    lostRounds: lostStaggered,
  });

  // ---------- ③ reload 之后：新代码真的生效了吗？数据还在吗？ ----------
  await page.evaluate((t) => chrome.storage.local.set({ __probe_token2: t + "-2" }), token);
  const beforeIds = await readIds();

  await page.evaluate(() => chrome.runtime.reload());
  await sleep(3000);

  const after = await waitForExt(25000);
  check("reload 后扩展仍然在（同一个扩展 ID）", !!after.extId && after.extId === extId, {
    before: extId,
    after: after.extId,
  });

  const page3 = await browser.newPage();
  await page3.goto(panelUrl(after.extId || extId), { waitUntil: "load", timeout: 20000 });
  await sleep(800);
  const post = await page3.evaluate(async () => {
    const out = { running: chrome.runtime.getManifest().version, id: chrome.runtime.id };
    try {
      const r = await fetch(chrome.runtime.getURL("staged-marker.txt"));
      out.newFileVisible = r.ok ? (await r.text()).trim() : "HTTP " + r.status;
    } catch (e) {
      out.newFileVisible = "ERR " + e.message;
    }
    const got = await chrome.storage.local.get(null);
    out.token = got.__probe_token || null;
    out.token2 = got.__probe_token2 || null;
    out.sessionIds = (got.ai_browser_sessions || []).map((s) => s.id);
    out.bytes = JSON.stringify(got).length;
    return out;
  });
  console.log("reload 之后:", JSON.stringify({ ...post, sessionIds: post.sessionIds.length }));
  check("reload 后新代码生效（运行时版本变成铺上去的那版）", post.running === STAGED_VERSION, {
    running: post.running,
  });
  check("reload 后新资源可读（staged-marker.txt）", post.newFileVisible === "staged by probe");
  check("reload 后 chrome.storage.local 数据仍在（API Key/设置类）", post.token === token && post.token2 === token + "-2");
  check(
    "reload 后会话历史仍在（一条不少）",
    post.sessionIds.length === beforeIds.length && beforeIds.every((id) => post.sessionIds.includes(id)),
    { before: beforeIds.length, after: post.sessionIds.length }
  );

  if (pageErrors.length) console.log("侧栏页面报错:", pageErrors.slice(0, 5));
} catch (e) {
  console.log("探针异常:", (e && e.message) || e);
  bad++;
} finally {
  await browser.close().catch(() => {});
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch (_) {}
}

console.log(`\n===== 探针结果：${ok}/${ok + bad} 通过 =====`);
process.exit(bad ? 1 : 0);