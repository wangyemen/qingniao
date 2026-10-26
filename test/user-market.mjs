// 用户市场（官网接口）+ 两个市场并列 + 分页 + 插件内投稿 的端到端测试
//
// 用户需求：
//   · 官方市场走 GitHub（不变）；用户市场走官网接口（本地起个假接口来验）
//   · 两个市场**并列**、共用同一套展示框架 + **都要分页**
//   · 用户市场装好后**默认停用**（社区投稿，不是官方出品）
//   · 插件里能直接投稿（POST 到 submit.php）
//
// 运行：node test/user-market.mjs

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { launchEdge } from "./edge-launch.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT = path.resolve(__dirname, "..");
const PORT = 8819;

let pass = 0,
  fail = 0;
const check = (name, ok, extra) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra !== undefined ? "  [" + extra + "]" : ""}`);
  ok ? pass++ : fail++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- 假的"官网用户市场"接口 ----------
//   15 个技能（用来验分页：每页 12 → 两页）
const SKILLS = Array.from({ length: 15 }, (_, i) => {
  const n = i + 1;
  return {
    id: `user-skill-${n}`,
    title: `用户技能 ${n}`,
    description: `第 ${n} 个社区投稿技能`,
    version: "1.0.0",
    author: n % 2 ? "热心网友" : "匿名",
    tags: ["社区", n % 3 ? "测试" : "刷题"],
    icon: "🧪",
    file: `http://127.0.0.1:${PORT}/api/skill.php?id=${n}`,
    market: "user",
    downloads: n,
    updatedAt: "2026-10-26 10:00:00",
  };
});
const submitted = [];

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  const json = (obj, code = 200) => {
    res.writeHead(code, { "Content-Type": "application/json; charset=utf-8", "Access-Control-Allow-Origin": "*" });
    res.end(JSON.stringify(obj));
  };

  if (url.pathname.endsWith("/market.php")) {
    return json({
      ok: true,
      market: "user",
      name: "用户市场（测试）",
      updatedAt: "2026-10-26 10:00:00",
      count: SKILLS.length,
      skills: SKILLS,
    });
  }
  if (url.pathname.endsWith("/skill.php")) {
    const id = Number(url.searchParams.get("id") || 0);
    const s = SKILLS.find((x) => x.file.endsWith("id=" + id)) || SKILLS[0];
    res.writeHead(200, { "Content-Type": "text/markdown; charset=utf-8", "Access-Control-Allow-Origin": "*" });
    return res.end(
      `<!-- qingniao-skill\nname: ${s.id}\ntitle: ${s.title}\ndescription: ${s.description}\n` +
        `version: ${s.version}\nauthor: ${s.author}\ntags: ${s.tags.join(", ")}\n-->\n\n` +
        `## 什么时候用\n\n用户说"跑一下 ${s.title}"的时候。\n\n## 步骤\n\n1. 第一步\n2. 第二步\n`
    );
  }
  if (url.pathname.endsWith("/submit.php")) {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      let j = null;
      try {
        j = JSON.parse(body);
      } catch (_) {}
      submitted.push(j);
      json({ ok: true, id: 99, slug: (j && j.slug) || "x", status: "pending", editToken: "tok-测试-123", message: "投稿已收到，等待审核" }, 201);
    });
    return;
  }
  if (req.method === "OPTIONS") {
    res.writeHead(204, { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "Content-Type", "Access-Control-Allow-Methods": "GET, POST, OPTIONS" });
    return res.end();
  }
  res.writeHead(404);
  res.end("nope");
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

try {
  const page = await browser.newPage();
  await page.goto(`chrome-extension://${extId}/options/index.html`, { waitUntil: "load", timeout: 20000 });
  await page.waitForSelector("#tabUser", { timeout: 10000 });
  await page.on("dialog", async (d) => {
    try {
      await d.accept(); // 投稿前的确认框
    } catch (_) {}
  });

  // ---------- ① 两个市场并列 + 切换 ----------
  const tabs = await page.evaluate(() => {
    const box = document.getElementById("tabOfficial").parentElement;
    const cs = getComputedStyle(box);
    return {
      display: cs.display,
      count: box.querySelectorAll(".mk-tab").length,
      labels: [...box.querySelectorAll(".mk-tab")].map((b) => b.textContent.trim().slice(0, 12)),
    };
  });
  check("两个市场是**并列**的一排（同一个容器、flex 横排）", tabs.display === "flex" && tabs.count === 2, JSON.stringify(tabs));

  // ---------- ② 切到用户市场 → 从官网接口拉取并渲染 ----------
  await page.evaluate((u) => {
    document.getElementById("userSourceInput").value = u;
    document.getElementById("tabUser").click();
  }, `http://127.0.0.1:${PORT}/api/market.php`);
  await sleep(2200);
  const userView = await page.evaluate(() => ({
    cards: document.querySelectorAll("#marketList .card").length,
    badge: (document.querySelector("#marketList .chip-user") || {}).textContent || "",
    meta: document.getElementById("marketMeta").textContent,
    pagerVisible: !document.getElementById("marketPager").classList.contains("hidden"),
    pager: document.getElementById("marketPager").textContent.replace(/\s+/g, " ").trim().slice(0, 60),
  }));
  check("用户市场拉取成功并渲染", userView.cards > 0, JSON.stringify(userView).slice(0, 200));
  check("卡片上标明「用户投稿 · 未审核」", /用户投稿/.test(userView.badge), userView.badge);
  check("来源显示为用户市场", /用户市场/.test(userView.meta), userView.meta.slice(0, 60));

  // ---------- ③ 分页（15 条 / 每页 12 → 两页）----------
  check("第一页只渲染 12 张卡（分页生效）", userView.cards === 12, `cards=${userView.cards}`);
  check("分页条出现且写着第 1 / 2 页", userView.pagerVisible && /第 1 \/ 2 页/.test(userView.pager), userView.pager);

  await page.evaluate(() => {
    const btn = [...document.querySelectorAll("#marketPager .mk-page")].find((b) => /下一页/.test(b.textContent));
    if (btn) btn.click();
  });
  await sleep(700);
  const page2 = await page.evaluate(() => ({
    cards: document.querySelectorAll("#marketList .card").length,
    pager: document.getElementById("marketPager").textContent.replace(/\s+/g, " ").trim().slice(0, 40),
  }));
  check("翻到第二页只剩 3 张卡", page2.cards === 3, JSON.stringify(page2));

  // ---------- ④ 安装用户市场的技能 → 默认停用 + 正文干净 ----------
  await page.evaluate(() => {
    const card = document.querySelector("#marketList .card");
    const btn = [...card.querySelectorAll("button")].find((b) => /安装/.test(b.textContent));
    if (btn) btn.click();
  });
  await sleep(2500);
  const installed = await page.evaluate(async () => {
    const all = await chrome.storage.local.get(null);
    const list = Object.values(all.ai_skills || {});
    const s = list.find((x) => x.market === "user") || null;
    return s ? { id: s.id, enabled: s.enabled, market: s.market, bodyHasMeta: /qingniao-skill|^\s*name:\s/m.test(s.body || ""), bodyHead: (s.body || "").slice(0, 18) } : null;
  });
  check("用户市场的技能装进来了", !!installed, JSON.stringify(installed));
  check("★ 装好后默认是**停用**状态（社区投稿要先看一眼）", installed && installed.enabled === false, JSON.stringify(installed));
  check("正文干净（没有元数据残留）", installed && !installed.bodyHasMeta, JSON.stringify(installed));

  // ---------- ⑤ 插件内投稿 ----------
  submitted.length = 0;
  await page.evaluate(async () => {
    const all = await chrome.storage.local.get(null);
    const skillsMap = all.ai_skills || {};
    skillsMap["my-publish-test"] = {
      id: "my-publish-test",
      title: "我的测试技能",
      description: "用来验投稿",
      version: "2.0.0",
      author: "我",
      tags: ["测试"],
      icon: "🚀",
      body: "## 步骤\n\n1. 打开\n2. 点击\n",
      enabled: true,
      source: "local",
    };
    await chrome.storage.local.set({ ai_skills: skillsMap });
  });
  await sleep(900);
  const clicked = await page.evaluate(() => {
    const cards = [...document.querySelectorAll("#mineList .card")];
    const card = cards.find((c) => c.textContent.includes("我的测试技能"));
    if (!card) return false;
    const btn = [...card.querySelectorAll("button")].find((b) => /投稿到用户市场/.test(b.textContent));
    if (!btn) return false;
    btn.click();
    return true;
  });
  check("我的技能里有「投稿到用户市场」按钮", clicked, "");
  await sleep(1800);
  const post = submitted[submitted.length - 1];
  check("投稿请求发出去了且打到 submit.php", !!post, JSON.stringify(submitted.length));
  check(
    "投稿内容正确（带 from=plugin、agree、正文已剥元数据）",
    post && post.from === "plugin" && post.agree === true && post.slug === "my-publish-test" && !/^\s*name:\s/m.test(post.body || ""),
    post ? JSON.stringify({ slug: post.slug, from: post.from, agree: post.agree, len: (post.body || "").length }) : ""
  );
  const statusText = await page.evaluate(() => (document.getElementById("marketStatus") || {}).textContent || "");
  check("界面提示投稿结果（含 editToken）", /待审核|editToken|已提交/.test(statusText), statusText.slice(0, 90));

  // ---------- ⑥ 官方市场不受影响（还是那套 GitHub 逻辑）----------
  await page.evaluate(() => document.getElementById("tabOfficial").click());
  await sleep(600);
  const back = await page.evaluate(() => ({
    officialVisible: !document.getElementById("officialSourceField").classList.contains("hidden"),
    userHidden: document.getElementById("userSourceField").classList.contains("hidden"),
    activeTab: document.querySelector(".mk-tab.active").id,
  }));
  check("切回官方市场：来源框与列表跟着换（同一套框架）", back.officialVisible && back.userHidden && back.activeTab === "tabOfficial", JSON.stringify(back));
} finally {
  await browser.close().catch(() => {});
  server.close();
  fs.rmSync(tmpExt, { recursive: true, force: true });
  fs.rmSync(tmpProfile, { recursive: true, force: true });
}

console.log(`\n===== 用户市场：${pass}/${pass + fail} 通过 =====`);
process.exit(fail ? 1 : 0);