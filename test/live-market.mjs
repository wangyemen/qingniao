// 真实联网验证：用扩展自己的 lib 去拉 GitHub 上的技能市场与 version.txt。
// 这是"用户点获取技能"时走的同一条代码路径（多镜像兜底）。
//
// 用法： node test/live-market.mjs

import { fetchMarketIndex, fetchSkillMd, fileCandidates, fetchFirstText, parseRepo } from "../lib/skills.js";
import { loadRemoteVersionTxt, parseVersionTxt } from "../lib/updates.js";

// Node 里没有 chrome.runtime，updates.js 的 loadLocalVersionTxt 不会被调用
globalThis.chrome = { runtime: { getURL: (p) => p } };

const REPO = "https://github.com/wangyemen/qingniao";
let pass = 0,
  fail = 0;
const check = (name, ok, extra) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? "  [" + extra + "]" : ""}`);
  ok ? pass++ : fail++;
};

console.log("=== 1) 解析仓库地址 ===");
const info = parseRepo(REPO);
check("能从仓库地址解析出 owner/repo/分支", !!info && info.owner === "wangyemen" && info.name === "qingniao", JSON.stringify(info));

console.log("\n=== 2) 拉技能目录（多镜像兜底）===");
let mk = null;
try {
  mk = await fetchMarketIndex(REPO);
  check("技能目录拉取成功", mk.count > 0, `来源=${mk.label} 技能数=${mk.count}`);
  console.log("     尝试过的镜像：" + (mk.tried.length ? mk.tried.join("、") : "第一个就成功"));
  console.log("     技能：" + mk.index.skills.map((s) => `${s.id}(v${s.version})`).join(", "));
} catch (err) {
  check("技能目录拉取成功", false, String(err.message || err));
}

console.log("\n=== 3) 下载某个技能的正文 ===");
if (mk && mk.index.skills.length) {
  const target = mk.index.skills.find((s) => s.id === "page-summary") || mk.index.skills[0];
  try {
    const got = await fetchSkillMd(mk.bases, target);
    const hasFm = /^---/.test(got.text.trim());
    check("技能正文下载成功且带 frontmatter", got.text.length > 200 && hasFm, `来源=${got.label} 长度=${got.text.length}`);
    check("正文内容对得上（出现技能自己的关键词）", /什么时候用|步骤/.test(got.text), "");
  } catch (err) {
    check("技能正文下载成功", false, String(err.message || err));
  }
}

console.log("\n=== 4) 联网读 version.txt ===");
const vt = await loadRemoteVersionTxt({ repo: REPO });
if (vt) {
  check("version.txt 联网读取成功", !!vt.latest, `latest=${vt.latest} 条目=${(vt.entries || []).length}`);
} else {
  check("version.txt 联网读取成功", false, "所有镜像都失败");
}

console.log("\n=== 5) 故意给一个坏来源，确认错误信息可读 ===");
try {
  await fetchMarketIndex("https://github.com/wangyemen/definitely-not-a-repo-xyz");
  check("坏来源应当报错", false, "居然成功了");
} catch (err) {
  check("坏来源报错且说明尝试过哪些镜像", /已尝试/.test(String(err.message || err)), String(err.message || err).slice(0, 90));
}

console.log(`\n===== live 结果：${pass}/${pass + fail} 通过 =====`);
process.exit(fail ? 1 : 0);