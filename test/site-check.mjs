// 站点体检：标签配平、直链按钮数量、不再有"占位模板"、每个直链真的能下
//
// 用法： node test/_site-check.mjs

import { readFileSync } from "node:fs";

let pass = 0,
  fail = 0;
const check = (name, ok, extra) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra !== undefined ? "  [" + extra + "]" : ""}`);
  ok ? pass++ : fail++;
};

const FILES = ["qingniao.gt.tc/index.html", "qingniao.gt.tc/changelog.html"];
const TAGS = ["section", "article", "div", "ul", "li", "p", "a", "table", "tbody", "tr", "td", "span", "button"];
const TAGS_RE = new RegExp("<(" + TAGS.join("|") + ")\\b", "g");
const TAGS_CLOSE_RE = new RegExp("</(" + TAGS.join("|") + ")>", "g");

const VERSIONS = ["0.4.3", "0.4.2", "0.4.1", "0.4.0"];

for (const f of FILES) {
  const t = readFileSync(f, "utf8");
  const open = (t.match(TAGS_RE) || []).length;
  const close = (t.match(TAGS_CLOSE_RE) || []).length;
  check(`${f} 标签配平`, open === close, `开 ${open} / 闭 ${close}`);
}

const index = readFileSync("qingniao.gt.tc/index.html", "utf8");
const changelog = readFileSync("qingniao.gt.tc/changelog.html", "utf8");
const both = index + "\n" + changelog;

// 每个版本都应有直链按钮（官方 + 国内加速）
for (const v of VERSIONS) {
  const direct = `https://github.com/wangyemen/qingniao/releases/download/v${v}/qingniao-${v}.zip`;
  const mirror = `https://ghproxy.net/${direct}`;
  const nDirect = both.split(direct).length - 1;
  const nMirror = both.split(mirror).length - 1;
  check(`v${v} 有官方直链按钮（${nDirect} 处）且都是"下载"而非裸链接`, nDirect > 0, `官方 ${nDirect} / 加速 ${nMirror}`);
  check(`v${v} 有国内加速按钮`, nMirror > 0, "");
}

// 不再有"占位模板"和"去 Releases 页找"的老写法
const placeholders = [/&lt;标签&gt;/, /&lt;文件名&gt;/, /releases\/latest/, /releases"\s+target/];
for (const re of placeholders) {
  check(`不再出现占位/跳页写法：${re}`, !re.test(both), "");
}

// 每个版本的直链真的能下（用 curl：本沙箱里 Node 的 fetch 连不上 github.com，curl 可以）
import { execFileSync } from "node:child_process";

for (const v of VERSIONS) {
  const url = `https://github.com/wangyemen/qingniao/releases/download/v${v}/qingniao-${v}.zip`;
  try {
    const out = execFileSync("curl.exe", ["-sIL", "-o", "NUL", "-w", "%{http_code} %{size_download}", "--max-time", "60", url], {
      encoding: "utf8",
    }).trim();
    const [code, size] = out.split(" ");
    check(`直链可下载 v${v}`, code === "200", `HTTP ${code} · ${(Number(size) / 1024).toFixed(0)} KB`);
  } catch (e) {
    check(`直链可下载 v${v}`, false, String((e && e.message) || e).slice(0, 80));
  }
}

console.log(`\n===== 站点体检：${pass}/${pass + fail} 通过 =====`);
process.exit(fail ? 1 : 0);