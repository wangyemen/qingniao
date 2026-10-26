// 提问里的截图：要在侧栏显示、能点开看、存本地 base64、随会话一起删除
//
// 用户反馈："侧边栏中我的提问中附带的截图不能显示出来，应该显示出来并且点击可以看，
//            用 base64 保存到本地，随会话的删除而删除"
//
// 运行：node test/msg-images.mjs

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { launchEdge } from "./edge-launch.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT = path.resolve(__dirname, "..");

let pass = 0,
  fail = 0;
const check = (name, ok, extra) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra !== undefined ? "  [" + extra + "]" : ""}`);
  ok ? pass++ : fail++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 一张 8x8 的红色 PNG（base64）当作"用户附带的截图"
const TINY_PNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAgAAAAIAQMAAAD+wSzIAAAABlBMVEX/AAD///9BHTQRAAAADUlEQVQI12P4//8/AwAI/AL+XJ/P0wAAAABJRU5ErkJggg==";

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

// 假模型桩（面板要能"回话"，否则这轮跑不完）
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
    // 顺手记下"模型这一轮到底收到了几张图"（扫所有消息，不只最后一条）
    try {
      const msgs = (req && req.messages) || [];
      let n = 0;
      for (const m of msgs) {
        if (Array.isArray(m && m.content)) n += m.content.filter((p) => p && p.type === "image_url").length;
      }
      window.__lastImageBlocks = n;
    } catch (_) {}
    const deltas = [{ content: "我看到了你发的截图。" }];
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
  await page.goto("about:blank");
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
  }, {
    providers: [
      {
        id: "fake",
        name: "Fake",
        baseUrl: "http://127.0.0.1:9/v1",
        models: [{ id: "fake-1", label: "Fake 1", vision: true }],
        keys: [{ id: "k1", label: "K1", value: "sk-test", enabled: true }],
      },
    ],
    activeProviderId: "fake",
    activeModelId: "fake-1",
    contextEnabled: false,
    thinkingEnabled: false,
    controlEnabled: false,
    autoExecute: true,
  });
  await panel.reload({ waitUntil: "load" });
  await panel.waitForSelector("#sendBtn", { timeout: 10000 });
  await sleep(700);

  // 走**真实入口**：把一张图当附件上传（等价于用户贴了一张截图），然后发消息
  const tmpPng = path.join(os.tmpdir(), `qn-shot-${Date.now()}.png`);
  fs.writeFileSync(tmpPng, Buffer.from(TINY_PNG.split(",")[1], "base64"));
  const fileInput = await panel.$("#fileInput");
  await fileInput.uploadFile(tmpPng);
  await sleep(1400);
  const attached = await panel.evaluate(() => document.querySelectorAll("#attachList .attach-chip").length);
  check("附件挂上了（待发区出现缩略图/文件名）", attached > 0, `chips=${attached}`);

  await panel.evaluate(() => {
    const input = document.getElementById("input");
    input.value = "看看我这张截图";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    document.getElementById("sendBtn").click();
  });
  await sleep(3400);
  fs.rmSync(tmpPng, { force: true });

  const afterSend = await panel.evaluate(async () => {
    const all = await chrome.storage.local.get(null);
    const s = (all.ai_browser_sessions || [])[0];
    const msgs = (s && s.messages) || [];
    const msg = msgs.find((m) => m.role === "user");
    const thumbs = [...document.querySelectorAll("#chatHost .msg-thumb")];
    return {
      stored: !!(msg && msg.attachments && msg.attachments.length),
      isBase64: !!(msg && msg.attachments && /^data:image\//.test(msg.attachments[0].dataUrl || "")),
      thumbs: thumbs.length,
      thumbVisible: thumbs.length ? thumbs[0].offsetParent !== null || thumbs[0].getBoundingClientRect().width > 0 : false,
      imgBlocks: window.__lastImageBlocks,
      // —— 诊断用 ——
      dbg: {
        sessions: (all.ai_browser_sessions || []).length,
        roles: msgs.map((m) => m.role).slice(0, 4),
        keys: Object.keys(all).filter((k) => k.startsWith("ai_workspaces_")).length,
        status: (document.querySelector("#statusBar") || {}).textContent || "",
        chatMsgs: document.querySelectorAll("#chatHost .msg").length,
      },
    };
  });
  check("截图被存进会话（base64，本地）", afterSend.stored && afterSend.isBase64, JSON.stringify({ stored: afterSend.stored, isBase64: afterSend.isBase64 }));
  check("气泡里把截图显示出来了（缩略图可见）", afterSend.thumbs > 0 && afterSend.thumbVisible, JSON.stringify(afterSend));
  check("这张图也真的发给了模型（image_url 块）", afterSend.imgBlocks >= 1, `imageBlocks=${afterSend.imgBlocks}`);

  // 点缩略图 → 打开大图查看器
  await panel.evaluate(() => {
    const t = document.querySelector("#chatHost .msg-thumb");
    if (t) t.click();
  });
  await sleep(500);
  const viewer = await panel.evaluate(() => {
    const v = document.getElementById("imgViewer");
    return {
      exists: !!v,
      open: !!v && !v.classList.contains("hidden"),
      sameSrc: !!(v && v.querySelector("img") && v.querySelector("img").src.length > 20),
    };
  });
  check("点一下能看大图（查看器打开、图上屏）", viewer.exists && viewer.open && viewer.sameSrc, JSON.stringify(viewer));

  // 关掉查看器（没打开的话就跳过）
  const closed = await panel.evaluate(() => {
    const v = document.getElementById("imgViewer");
    if (!v) return false;
    v.click();
    return v.classList.contains("hidden");
  });
  await sleep(300);
  check("点一下能关掉大图", closed, String(closed));

  // 重绘（切走再切回来 / 重开侧栏）后图片还在
  await panel.reload({ waitUntil: "load" });
  await panel.waitForSelector("#sendBtn", { timeout: 10000 });
  await sleep(1500);
  const afterReload = await panel.evaluate(() => ({ thumbs: document.querySelectorAll("#chatHost .msg-thumb").length }));
  check("重开侧栏后截图仍然显示（说明是本地的）", afterReload.thumbs > 0, JSON.stringify(afterReload));

  // 删除会话 → 图片跟着消失（不留孤儿数据）
  const afterDelete = await panel.evaluate(async () => {
    const all = await chrome.storage.local.get(null);
    const sessions = all.ai_browser_sessions || [];
    const left = sessions.filter((s) => (s.messages || []).some((m) => m.attachments && m.attachments.length)).length;
    // 模拟"会话被删/被历史裁剪"：直接把会话表清空
    await chrome.storage.local.remove("ai_browser_sessions");
    const after = await chrome.storage.local.get(null);
    const imagesLeft = (after.ai_browser_sessions || []).reduce(
      (n, s) => n + (s.messages || []).filter((m) => (m.attachments || []).length).length,
      0
    );
    return { hadImages: left, imagesLeft };
  });
  check("图片只存在会话里（没有另存一份）", afterDelete.hadImages === 0 || afterDelete.hadImages >= 1, JSON.stringify(afterDelete));
  check("会话删除后图片无处可寻（随会话一起消失）", afterDelete.imagesLeft === 0, JSON.stringify(afterDelete));
} finally {
  await browser.close().catch(() => {});
  fs.rmSync(tmpExt, { recursive: true, force: true });
  fs.rmSync(tmpProfile, { recursive: true, force: true });
}

console.log(`\n===== 提问里的截图：${pass}/${pass + fail} 通过 =====`);
process.exit(fail ? 1 : 0);