// 供应商接入方式测试：openai 兼容 / anthropic 兼容 + 自定义请求头
//
// 用户需求：
//   ① 有些网关（如 Cloudflare AI Gateway）需要**自定义请求头** → 供应商上加"请求头"配置
//   ② 兼容方式二选一：**OpenAI 兼容**（/chat/completions，Bearer）或 **Anthropic 兼容**（/messages，x-api-key）
//
// 这里起一个真的本地服务器，同时实现这两个端点，直接看扩展**实际发出的请求**对不对
// （不拦 fetch、不打桩模型 —— 走完整链路）。
//
// 运行：node test/api-compat.mjs

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { launchEdge } from "./edge-launch.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT = path.resolve(__dirname, "..");
const PORT = 8817;

let pass = 0,
  fail = 0;
const check = (name, ok, extra) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra !== undefined ? "  [" + extra + "]" : ""}`);
  ok ? pass++ : fail++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- 假"模型服务器"：同时支持两种兼容端点，并记下收到的请求 ----------
const seen = [];
const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    let json = null;
    try {
      json = JSON.parse(body);
    } catch (_) {}
    seen.push({ path: req.url, method: req.method, headers: req.headers, body: json });

    const sse = (lines) => {
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
      for (const l of lines) res.write(l);
      res.end();
    };

    // ① OpenAI 兼容：/v1/chat/completions
    if (/\/chat\/completions$/.test(req.url)) {
      sse([
        "data: " + JSON.stringify({ choices: [{ delta: { content: "我是" } }] }) + "\n\n",
        "data: " + JSON.stringify({ choices: [{ delta: { content: " OpenAI 兼容的回复" } }] }) + "\n\n",
        "data: [DONE]\n\n",
      ]);
      return;
    }
    // ② Anthropic 兼容：/v1/messages
    if (/\/messages$/.test(req.url)) {
      sse([
        "event: message_start\ndata: " + JSON.stringify({ type: "message_start", message: { id: "m1" } }) + "\n\n",
        "event: content_block_delta\ndata: " +
          JSON.stringify({ type: "content_block_delta", delta: { type: "text_delta", text: "我是" } }) +
          "\n\n",
        "event: content_block_delta\ndata: " +
          JSON.stringify({ type: "content_block_delta", delta: { type: "text_delta", text: " Anthropic 兼容的回复" } }) +
          "\n\n",
        "event: message_stop\ndata: " + JSON.stringify({ type: "message_stop" }) + "\n\n",
      ]);
      return;
    }
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "not found" }));
  });
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

// 供应商配置由测试动态改写；面板用一个"不会真的被调用"的桩太麻烦 ——
// 这里让面板走**真实网络**：baseUrl 指向本地服务器。所以不装 fetch 桩。
const providerFor = (compat, headers) => ({
  id: "p-" + compat,
  name: "本地 " + compat,
  baseUrl: `http://127.0.0.1:${PORT}/v1`,
  apiCompat: compat,
  headers: headers || [],
  models: [{ id: compat === "anthropic" ? "claude-x" : "gpt-x", label: "测试模型" }],
  keys: [{ id: "k1", label: "主", value: "sk-test-key", enabled: true }],
});

try {
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${PORT}/nothing.html`, { waitUntil: "load" }).catch(() => {});

  const panel = await browser.newPage();
  await panel.goto(`chrome-extension://${extId}/sidepanel/index.html`, { waitUntil: "load", timeout: 20000 });
  await panel.waitForSelector("#sendBtn", { timeout: 10000 });

  const setProvider = (prov) =>
    panel.evaluate(async (p) => {
      const all = await chrome.storage.local.get(null);
      const s = all.ai_browser_settings || {};
      s.providers = [p];
      s.activeProviderId = p.id;
      s.activeModelId = p.models[0].id;
      s.contextEnabled = false;
      s.thinkingEnabled = false;
      s.controlEnabled = false;
      s.autoExecute = true;
      await chrome.storage.local.set({ ai_browser_settings: s });
      const keys = Object.keys(all).filter((k) => k.startsWith("ai_workspaces_"));
      if (keys.length) await chrome.storage.local.remove(keys);
      await chrome.storage.local.remove("ai_browser_sessions");
    }, prov);

  const send = async (text) => {
    seen.length = 0;
    await page.bringToFront();
    await panel.evaluate((t) => {
      const inp = document.getElementById("input");
      inp.value = t;
      document.getElementById("sendBtn").click();
    }, text);
    await sleep(3500);
  };

  const sessionTail = () =>
    panel.evaluate(async () => {
      const all = await chrome.storage.local.get(null);
      const s = (all.ai_browser_sessions || [])[0];
      return ((s && s.messages) || [])
        .map((m) => `${m.role}: ${String(m.content || "").slice(0, 160)}`)
        .join("\n");
    });

  // ---------- ① OpenAI 兼容 ----------
  await setProvider(providerFor("openai"));
  await panel.reload({ waitUntil: "load" });
  await panel.waitForSelector("#sendBtn", { timeout: 10000 });
  await sleep(600);
  await send("你好");
  const oa = seen.find((r) => /\/chat\/completions$/.test(r.path || ""));
  check("① OpenAI 兼容：请求打到 /v1/chat/completions", !!oa, JSON.stringify(seen.map((s) => s.path)));
  check(
    "① 自动带 Authorization: Bearer <Key>",
    oa && oa.headers["authorization"] === "Bearer sk-test-key",
    oa ? String(oa.headers["authorization"]) : ""
  );
  check("① 请求体是 messages + model（OpenAI 形状）", oa && Array.isArray(oa.body.messages) && oa.body.model === "gpt-x", oa ? JSON.stringify(Object.keys(oa.body)) : "");
  const oaTail = await sessionTail();
  check("① 回复文字进了会话", /OpenAI 兼容的回复/.test(oaTail), oaTail.split("\n").slice(-2).join(" | ").slice(0, 120));

  // ---------- ② OpenAI 兼容 + 自定义请求头（Cloudflare AI Gateway 场景）----------
  await setProvider(
    providerFor("openai", [
      { name: "cf-aig-authorization", value: "Bearer gw-token-123" },
      { name: "X-Tenant", value: "{{key}}" },
    ])
  );
  await panel.reload({ waitUntil: "load" });
  await panel.waitForSelector("#sendBtn", { timeout: 10000 });
  await sleep(600);
  await send("你好");
  const oa2 = seen.find((r) => /\/chat\/completions$/.test(r.path || ""));
  check(
    "② 自定义请求头真的发出去了（cf-aig-authorization）",
    oa2 && oa2.headers["cf-aig-authorization"] === "Bearer gw-token-123",
    oa2 ? String(oa2.headers["cf-aig-authorization"]) : ""
  );
  check("② 值里的 {{key}} 被替换成当前 API Key", oa2 && oa2.headers["x-tenant"] === "sk-test-key", oa2 ? String(oa2.headers["x-tenant"]) : "");
  check("② 原有的 Bearer 鉴权还在（网关要两个都有）", oa2 && oa2.headers["authorization"] === "Bearer sk-test-key", oa2 ? String(oa2.headers["authorization"]) : "");

  // ---------- ③ Anthropic 兼容 ----------
  await setProvider(providerFor("anthropic"));
  await panel.reload({ waitUntil: "load" });
  await panel.waitForSelector("#sendBtn", { timeout: 10000 });
  await sleep(600);
  await send("你好");
  const an = seen.find((r) => /\/messages$/.test(r.path || ""));
  check("③ Anthropic 兼容：请求打到 /v1/messages", !!an, JSON.stringify(seen.map((s) => s.path)));
  check(
    "③ 自动带 x-api-key 与 anthropic-version",
    an && an.headers["x-api-key"] === "sk-test-key" && an.headers["anthropic-version"] === "2023-06-01",
    an ? JSON.stringify({ k: an.headers["x-api-key"], v: an.headers["anthropic-version"] }) : ""
  );
  check("③ 没有带 OpenAI 那套 Authorization", an && !an.headers["authorization"], an ? String(an.headers["authorization"] || "(无)") : "");
  check(
    "③ 请求体是 Anthropic 形状（max_tokens 必填 + messages 交替）",
    an && an.body && an.body.max_tokens > 0 && Array.isArray(an.body.messages) && !an.body.messages.some((m) => m.role === "system"),
    an ? JSON.stringify({ keys: Object.keys(an.body), roles: an.body.messages.map((m) => m.role) }) : ""
  );
  const anTail = await sessionTail();
  check("③ Anthropic 流事件被正确解析成回复", /Anthropic 兼容的回复/.test(anTail), anTail.split("\n").slice(-2).join(" | ").slice(0, 120));

  // ---------- ④ Anthropic 兼容 + 自定义头 + 覆盖 x-api-key ----------
  await setProvider(
    providerFor("anthropic", [
      { name: "X-Gateway", value: "gw-1" },
      { name: "x-api-key", value: "gateway-managed" },
    ])
  );
  await panel.reload({ waitUntil: "load" });
  await panel.waitForSelector("#sendBtn", { timeout: 10000 });
  await sleep(600);
  await send("你好");
  const an2 = seen.find((r) => /\/messages$/.test(r.path || ""));
  check("④ anthropic：自定义头也发出去", an2 && an2.headers["x-gateway"] === "gw-1", an2 ? String(an2.headers["x-gateway"]) : "");
  check(
    "④ 自定义的同名头覆盖自动值（x-api-key 以你的为准）",
    an2 && an2.headers["x-api-key"] === "gateway-managed",
    an2 ? String(an2.headers["x-api-key"]) : ""
  );
  check("④ 版本头仍然自动带上", an2 && an2.headers["anthropic-version"] === "2023-06-01", an2 ? String(an2.headers["anthropic-version"]) : "");

  // ---------- ⑤ 设置页 UI：两种兼容方式都能选、请求头能加 ----------
  const opts = await browser.newPage();
  await opts.goto(`chrome-extension://${extId}/options/index.html`, { waitUntil: "load", timeout: 20000 });
  await opts.waitForSelector("#providerList .provider-card", { timeout: 10000 });
  const ui = await opts.evaluate(() => {
    const card = document.querySelector("#providerList .provider-card");
    const sel = card.querySelector("select");
    const opts2 = sel ? [...sel.options].map((o) => o.value) : [];
    const hdrInputs = card.querySelectorAll(".hdr-row input").length;
    const hasCfBtn = [...card.querySelectorAll("button")].some((b) => /Cloudflare/i.test(b.textContent));
    const hasAdd = [...card.querySelectorAll("button")].some((b) => /添加请求头/.test(b.textContent));
    return { compatOptions: opts2, compatValue: sel ? sel.value : null, hdrInputs, hasCfBtn, hasAdd };
  });
  check(
    "⑤ 供应商卡片上有兼容方式选择（openai / anthropic 两项）",
    ui.compatOptions.includes("openai") && ui.compatOptions.includes("anthropic"),
    JSON.stringify(ui.compatOptions)
  );
  check("⑤ 有「添加请求头」与 Cloudflare 快捷按钮", ui.hasAdd && ui.hasCfBtn, JSON.stringify({ hasAdd: ui.hasAdd, hasCfBtn: ui.hasCfBtn }));

  // 点一下 Cloudflare 快捷按钮 → 真的加出一条头
  await opts.evaluate(() => {
    const card = document.querySelector("#providerList .provider-card");
    const btn = [...card.querySelectorAll("button")].find((b) => /Cloudflare/i.test(b.textContent));
    if (btn) btn.click();
  });
  await sleep(500);
  const after = await opts.evaluate(() => {
    const card = document.querySelector("#providerList .provider-card");
    // 卡片上原本已有别的头（X-Gateway）——要看**任意一行**里有没有新加的这条
    return [...card.querySelectorAll(".hdr-row input")].map((i) => i.value);
  });
  check("⑤ 点快捷按钮后多出一条 cf-aig-authorization", after.some((v) => /cf-aig-authorization/.test(v)), JSON.stringify(after));

  // ---------- ⑥ 迁移：老配置（没有 headers/apiCompat）加载后不报错、补成空表 ----------
  await opts.evaluate(async () => {
    await chrome.storage.local.set({
      ai_browser_settings: { providers: [{ id: "old", name: "老配置", baseUrl: "http://127.0.0.1:9/v1", models: [{ id: "m1", label: "m1" }], keys: [] }] },
    });
  });
  await opts.reload({ waitUntil: "load" });
  await opts.waitForSelector("#providerList .provider-card", { timeout: 10000 });
  const migrated = await opts.evaluate(() => {
    const card = document.querySelector("#providerList .provider-card");
    const sel = card.querySelector("select");
    return {
      cards: document.querySelectorAll("#providerList .provider-card").length,
      compat: sel ? sel.value : null,
      hdrRows: card.querySelectorAll(".hdr-row").length,
    };
  });
  check(
    "⑥ 老配置加载后不报错：兼容方式默认 openai、请求头表为空（迁移补的）",
    migrated.cards === 1 && migrated.compat === "openai" && migrated.hdrRows === 0,
    JSON.stringify(migrated)
  );
} finally {
  await browser.close().catch(() => {});
  server.close();
  fs.rmSync(tmpExt, { recursive: true, force: true });
  fs.rmSync(tmpProfile, { recursive: true, force: true });
}

console.log(`\n===== 接入方式：${pass}/${pass + fail} 通过 =====`);
process.exit(fail ? 1 : 0);