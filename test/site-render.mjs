// 用真实浏览器打开站点，验证"下载按钮"是否真的渲染出来
// （用户要求：不要显示成长链接，要按钮，点一下直接下载；每个版本都要有）
//
// ⚠️ 站点（qingniao.gt.tc/）**不随扩展仓库推送**（用户要求，已加进 .gitignore）。
//    本地有就跑；克隆仓库的人没有这个目录 → 直接跳过。
//
// 用法： node test/site-render.mjs

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { launchEdge } from "./edge-launch.mjs";

if (!fs.existsSync("qingniao.gt.tc/index.html")) {
  console.log("（跳过）本地没有 qingniao.gt.tc/ 站点目录 —— 站点不随扩展仓库推送，属正常");
  process.exit(0);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0,
  fail = 0;
const check = (name, ok, extra) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra !== undefined ? "  [" + extra + "]" : ""}`);
  ok ? pass++ : fail++;
};

const SITE = path.resolve("qingniao.gt.tc");
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "site-profile-"));
const browser = await launchEdge({ profile });

try {
  const page = await browser.newPage();
  await page.goto(pathToFileURL(path.join(SITE, "index.html")).href, { waitUntil: "load" });
  await sleep(5000); // 等脚本向 GitHub API 取到发布列表并重建

  const info = await page.evaluate(() => {
    const cards = [...document.querySelectorAll(".dl-ver")];
    const btns = [...document.querySelectorAll("a.btn[href*='/releases/download/']")];
    const rawUrls = [...document.querySelectorAll(".mirror-row .url, .dl-ver .url")]
      .map((s) => s.textContent.trim())
      .filter((t) => /github\.com\/.*\/releases\/download/.test(t));
    return {
      cards: cards.length,
      labels: cards.map((c) => (c.querySelector("b") || {}).textContent || ""),
      buttons: btns.length,
      perVersion: btns.reduce((m, a) => {
        const v = (a.href.match(/download\/(v[\d.]+)\//) || [])[1] || "?";
        m[v] = (m[v] || 0) + 1;
        return m;
      }, {}),
      sample: btns.slice(0, 2).map((a) => `${a.textContent.trim().slice(0, 14)} -> ${a.href.slice(-42)}`),
      liveHeading: (document.querySelector("#release-live h4") || {}).textContent || "",
      rawUrlCount: rawUrls.length,
    };
  });

  check("版本卡渲染出来（≥4 张）", info.cards >= 4, `cards=${info.cards} labels=${info.labels.join(",")}`);
  check("下载按钮渲染出来（≥8 个）", info.buttons >= 8, `buttons=${info.buttons} ${JSON.stringify(info.perVersion)}`);
  check("四个版本各自都有按钮", ["v0.4.3", "v0.4.2", "v0.4.1", "v0.4.0"].every((v) => info.perVersion[v] > 0), JSON.stringify(info.perVersion));
  check("不再把下载地址当文本显示", info.rawUrlCount === 0, `rawUrl=${info.rawUrlCount}`);
  check("自动读取那段有结果（实时或静态都可）", /发布|按版本下载/.test(info.liveHeading), info.liveHeading.slice(0, 40));

  // changelog 页：每个版本的按钮
  const cpage = await browser.newPage();
  await cpage.goto(pathToFileURL(path.join(SITE, "changelog.html")).href, { waitUntil: "load" });
  await sleep(800);
  const clog = await cpage.evaluate(() => {
    const heads = [...document.querySelectorAll(".timeline .vhead")];
    return {
      versions: heads.map((h) => (h.querySelector("b") || {}).textContent || ""),
      withButtons: heads.filter((h) => h.querySelector(".vdl a.btn")).length,
      totalButtons: document.querySelectorAll(".vdl a.btn, .hero-actions a.btn[href*='/releases/download/']").length,
    };
  });
  check("日志里每个版本都带下载按钮", clog.withButtons === clog.versions.length && clog.versions.length >= 4, JSON.stringify(clog));
} finally {
  await browser.close().catch(() => {});
  fs.rmSync(profile, { recursive: true, force: true });
}

console.log(`\n===== 站点渲染：${pass}/${pass + fail} 通过 =====`);
process.exit(fail ? 1 : 0);