// 技能导入（拖拽 / 选文件 / 粘贴）端到端测试
//   用户要求：现在只有导出，要加导入，支持拖动导入；导出格式已知，解析一下就好。
//
// 导出格式 = lib/skills.js 的 stringifySkillMd(meta, body)，即标准 SKILL.md：
//   ---
//   name: xxx
//   title: 显示名
//   ...
//   ---
//   正文…
//
// 运行：node test/skill-import.mjs

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

// 一份"导出出来"的 SKILL.md（与 skillMarkdown() 产出的形状一致）
const MD_ONE = `---
name: price-watch
title: 盯价格
description: 盯着某个商品的价格，降价了告诉我
version: 1.2.0
author: 测试
tags: [购物, 比价]
icon: 🛒
---

# 盯价格

什么时候用：用户说"帮我盯着这个价格"。

步骤：
1. 读商品页价格；
2. 记下来，循环等待；
3. 价格变了就汇报。

注意：
- 别频繁刷新，会被限流。
`;

const MD_TWO = `---
name: page-summary
title: 页面摘要
description: 把当前页面读一遍并总结
version: 1.0.0
---

把页面主要内容总结成三句话。
`;

// 市场目录那样的 JSON
const JSON_BUNDLE = JSON.stringify({
  skills: [
    { id: "from-json", title: "来自 JSON", description: "JSON 导入", version: "0.3.0", body: "# 正文\nJSON 里的内容" },
  ],
});

try {
  const opts = await browser.newPage();
  await opts.goto(`chrome-extension://${extId}/options/index.html`, { waitUntil: "load", timeout: 20000 });
  await opts.waitForSelector("#skillDrop", { timeout: 10000 });
  // 清掉已有技能，起点干净
  await opts.evaluate(() => chrome.storage.local.remove("ai_skills"));
  await opts.reload({ waitUntil: "load" });
  await opts.waitForSelector("#skillDrop", { timeout: 10000 });
  await sleep(500);

  // confirm 在无头浏览器里会**阻塞页面**（没人点按钮）→ 统一按"取消/不覆盖"处理
  opts.on("dialog", async (d) => {
    try {
      await d.dismiss();
    } catch (_) {}
  });

  const status = () => opts.evaluate(() => (document.getElementById("marketStatus") || {}).textContent || "");
  const loadSkills = () =>
    opts.evaluate(async () => {
      const all = await chrome.storage.local.get(null);
      return all.ai_skills || {};
    });

  // ---------- ① 拖拽导入（真实 DragEvent + DataTransfer）----------
  await opts.evaluate((text) => {
    const dt = new DataTransfer();
    dt.items.add(new File([text], "price-watch-SKILL.md", { type: "text/markdown" }));
    const zone = document.getElementById("skillDrop");
    zone.dispatchEvent(new DragEvent("dragenter", { dataTransfer: dt, bubbles: true, cancelable: true }));
    zone.dispatchEvent(new DragEvent("dragover", { dataTransfer: dt, bubbles: true, cancelable: true }));
    window.__dragover = zone.classList.contains("dragover");
    zone.dispatchEvent(new DragEvent("drop", { dataTransfer: dt, bubbles: true, cancelable: true }));
  }, MD_ONE);
  await sleep(1200);

  let skills = await loadSkills();
  const s1 = skills["price-watch"];
  check("拖拽悬停时高亮（用户知道松手能导入）", await opts.evaluate(() => window.__dragover === true), "");
  check("拖拽导入成功（按 frontmatter 的 name 建 id）", !!s1, Object.keys(skills).join(","));
  check(
    "标题/说明/版本/作者/标签都解析对了",
    s1 && s1.title === "盯价格" && s1.description.includes("降价") && s1.version === "1.2.0" && s1.author === "测试" && (s1.tags || []).includes("比价"),
    s1 ? JSON.stringify({ t: s1.title, v: s1.version, a: s1.author, tags: s1.tags }) : ""
  );
  check(
    "正文完整保留（含多行）",
    s1 && /# 盯价格/.test(s1.body) && /会被限流/.test(s1.body) && s1.body.split("\n").length > 5,
    s1 ? `行数=${s1.body.split("\n").length}` : ""
  );
  check("导入的技能是启用状态、来源 local", s1 && s1.enabled !== false && s1.source === "local", s1 ? JSON.stringify({ e: s1.enabled, src: s1.source }) : "");
  check("界面提示了导入结果", /已导入/.test(await status()), (await status()).slice(0, 80));

  // ---------- ② 一次拖两个 ----------
  await opts.evaluate((a, b) => {
    const dt = new DataTransfer();
    dt.items.add(new File([a], "page-summary-SKILL.md", { type: "text/markdown" }));
    dt.items.add(new File([b], "bundle.json", { type: "application/json" }));
    document.getElementById("skillDrop").dispatchEvent(new DragEvent("drop", { dataTransfer: dt, bubbles: true, cancelable: true }));
  }, MD_TWO, JSON_BUNDLE);
  await sleep(1400);
  skills = await loadSkills();
  check("一次拖多个文件：都导入了（md + json）", !!skills["page-summary"] && !!skills["from-json"], Object.keys(skills).join(","));

  // ---------- ③ 选文件导入（真实 <input type=file>）----------
  const tmpMd = path.join(os.tmpdir(), `qn-upload-${Date.now()}-SKILL.md`);
  fs.writeFileSync(tmpMd, MD_TWO.replace("page-summary", "uploaded-skill").replace("页面摘要", "上传来的"), "utf8");
  const input = await opts.$("#skillFileInput");
  await input.uploadFile(tmpMd);
  await sleep(1300);
  skills = await loadSkills();
  // id 来自 frontmatter 的 name（uploaded-skill），**不该**被当成文件名去剥 -skill
  check("从文件选择器导入成功（id 按 frontmatter 走，不被误剥后缀）", !!skills["uploaded-skill"], Object.keys(skills).join(","));
  fs.rmSync(tmpMd, { force: true });

  // ---------- ④ 同名冲突：默认"保留为新副本"（headless 下 confirm 返回 false）----------
  const before = Object.keys(skills).length;
  await opts.evaluate((text) => {
    const dt = new DataTransfer();
    dt.items.add(new File([text], "price-watch-SKILL.md", { type: "text/markdown" }));
    document.getElementById("skillDrop").dispatchEvent(new DragEvent("drop", { dataTransfer: dt, bubbles: true, cancelable: true }));
  }, MD_ONE);
  await sleep(1300);
  skills = await loadSkills();
  check(
    "同名导入不覆盖原技能（保留成新副本）",
    !!skills["price-watch"] && Object.keys(skills).length === before + 1,
    Object.keys(skills).join(",")
  );

  // ---------- ⑤ 坏文件：只跳过、不崩 ----------
  await opts.evaluate(() => {
    const dt = new DataTransfer();
    dt.items.add(new File(["这不是技能"], "logo.png", { type: "image/png" }));
    dt.items.add(new File(["", ], "empty-SKILL.md", { type: "text/markdown" }));
    document.getElementById("skillDrop").dispatchEvent(new DragEvent("drop", { dataTransfer: dt, bubbles: true, cancelable: true }));
  });
  await sleep(1200);
  const st = await status();
  check("坏文件只提示跳过，页面不崩", /没有导入|只支持|空的/.test(st), st.slice(0, 100));
  check("坏文件没有污染技能表", !(await loadSkills())["logo"], "");
  check("页面没有抛异常（仍然可用）", await opts.evaluate(() => !!document.getElementById("skillDrop")), "");
} finally {
  await browser.close().catch(() => {});
  fs.rmSync(tmpExt, { recursive: true, force: true });
  fs.rmSync(tmpProfile, { recursive: true, force: true });
}

console.log(`\n===== 技能导入：${pass}/${pass + fail} 通过 =====`);
process.exit(fail ? 1 : 0);