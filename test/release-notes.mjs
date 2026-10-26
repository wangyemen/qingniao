// 从 version.txt 抽取每个版本的段落，生成 GitHub Release 的说明文件（dist/rel-notes-<ver>.md）
//
// 用法： node test/_release-notes.mjs

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";

const VERSIONS = ["0.4.3", "0.4.2", "0.4.1"];

const txt = readFileSync("version.txt", "utf8");
const lines = txt.split(/\r?\n/);

// 按 "## <version>" 切段
const sections = new Map();
let cur = null;
for (const line of lines) {
  const m = /^##\s+(.+?)\s*$/.exec(line);
  if (m) {
    cur = m[1].trim();
    sections.set(cur, []);
    continue;
  }
  if (cur) sections.get(cur).push(line);
}

if (!existsSync("dist")) mkdirSync("dist");
for (const v of VERSIONS) {
  const body = (sections.get(v) || []).join("\n").trim();
  if (!body) {
    console.log(`跳过 ${v}：version.txt 里没有这一段的更新日志`);
    continue;
  }
  const notes =
    `**青鸟 · 浏览器助手 v${v}**\n\n` +
    `${body}\n\n` +
    `---\n` +
    `安装：把下面的 zip 解压到任意目录 → 浏览器打开 \`edge://extensions\`（或 \`chrome://extensions\`）→ ` +
    `开启「开发者模式」→「加载已解压的扩展程序」→ 选中解压出来的文件夹。\n` +
    `完整更新日志：[version.txt](https://github.com/wangyemen/qingniao/blob/main/version.txt)\n` +
    `说明：技能市场/更新检查优先走 GitHub API（实时），镜像兜底；国内可直连。\n`;
  const file = `dist/rel-notes-${v}.md`;
  writeFileSync(file, notes, "utf8");
  console.log(`已生成 ${file}（${notes.length} 字符）`);
}