// 技能文件格式：导出用「HTML 注释装元数据」的新格式，导入要容忍各种脏文件
//
// 背景（用户报的问题）：老格式用 Markdown 的 `---` frontmatter ——
//   · 开头一个 `---` 会被 Markdown 渲染成水平线，元数据文字直接显示出来；
//   · 解析只要不标准（BOM / 开头空行 / `...` 收尾）就整块失效 → 元数据被当成正文收进编辑框，
//     再保存就出现"两份 frontmatter"，越改越乱。
// 现在导出改用 `<!-- qingniao-skill … -->`（任何 Markdown/HTML 渲染都不显示它），
// 导入同时兼容新老两种格式。
//
// 用法： node test/skill-format.mjs

import {
  parseSkillMd,
  stringifySkillDoc,
  stringifySkillMd,
  stripSkillMeta,
} from "../lib/skills.js";

let pass = 0,
  fail = 0;
const check = (name, ok, extra) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra !== undefined ? "  [" + extra + "]" : ""}`);
  ok ? pass++ : fail++;
};

const META = {
  name: "163mooc-xingfa",
  title: "中国大学MOOC刑法",
  description: "中国大学MOOC自动刷题",
  version: "0.1.0",
  author: "青鸟",
  tags: ["刷题"],
};
const BODY = "## 步骤\n\n1. 打开课程页\n2. 点开始答题\n";
const hasMetaInBody = (b) => /qingniao-skill|^\s*name:\s|^\s*tags:\s|^---\s*$/m.test(String(b || ""));

// ---------- ① 导出格式：元数据在 HTML 注释里，正文干净 ----------
const doc = stringifySkillDoc(META, BODY);
check("导出以 <!-- qingniao-skill 开头（不在正文里显示）", doc.startsWith("<!-- qingniao-skill\n"), doc.split("\n")[0]);
check("导出不再用 --- frontmatter", !/^---\s*$/m.test(doc.split("-->")[0] + ""), doc.split("\n")[0]);
check("导出正文里没有元数据（注释块之后就是正文）", doc.split("-->")[1].trim().startsWith("## 步骤"), JSON.stringify(doc.split("-->")[1].trim().slice(0, 20)));

// ---------- ② 往返：导出 → 导入，字段与正文都对得上 ----------
const rt = parseSkillMd(doc);
check("回读 form = comment", rt.form === "comment", rt.form);
check(
  "元数据全部还原",
  rt.meta.name === META.name &&
    rt.meta.title === META.title &&
    rt.meta.description === META.description &&
    rt.meta.version === META.version &&
    rt.meta.author === META.author &&
    Array.isArray(rt.meta.tags) &&
    rt.meta.tags[0] === "刷题",
  JSON.stringify(rt.meta)
);
check("正文只有正文（没有注释块、没有 name:/title:）", !hasMetaInBody(rt.body) && rt.body.startsWith("## 步骤"), JSON.stringify(rt.body.slice(0, 24)));

// ---------- ③ 脏文件也要认（用户踩过的那些） ----------
const dirty = [
  ["带 BOM", "\uFEFF" + doc],
  ["开头一个空行", "\n" + doc],
  ["开头两个空行 + 空格", "\n\n  " + doc],
  ["CRLF 换行", doc.replace(/\n/g, "\r\n")],
  ["注释结束标记前有空格", doc.replace("\n-->", "  \n-->")],
];
for (const [label, text] of dirty) {
  const r = parseSkillMd(text);
  check(`${label} → 元数据认得出且不混进正文`, r.meta.name === META.name && !hasMetaInBody(r.body), `form=${r.form}`);
}

// ---------- ④ 老格式（技能市场那批 SKILL.md）继续支持 ----------
const oldDoc = stringifySkillMd(META, BODY);
const oldParsed = parseSkillMd(oldDoc);
check("老格式（--- frontmatter）仍能解析", oldParsed.meta.name === META.name && oldParsed.form === "frontmatter", oldParsed.form);
const oldDirty = [
  ["老格式带 BOM", "\uFEFF" + oldDoc],
  ["老格式开头空行", "\n" + oldDoc],
  ["老格式用 ... 收尾", oldDoc.replace("\n---\n", "\n...\n")],
  ["老格式 fence 带尾随空格", oldDoc.replace("\n---\n", "\n---  \n")],
  ["老格式 CRLF", oldDoc.replace(/\n/g, "\r\n")],
];
for (const [label, text] of oldDirty) {
  const r = parseSkillMd(text);
  check(`${label} → 也能认（这就是之前整块混进正文的根因）`, r.meta.name === META.name && r.form === "frontmatter", JSON.stringify(r.meta.name || null));
}

// ---------- ⑤ 不能误伤：正文里的 --- 分隔线、以及纯正文文件 ----------
const plain = "## 只是正文\n\n---\n\n下面还有内容\n";
const plainParsed = parseSkillMd(plain);
check("纯正文（含 --- 分隔线）不被当成元数据", Object.keys(plainParsed.meta).length === 0 && plainParsed.body === plain, `form=${plainParsed.form}`);
const hrOnly = "---\n\n只是想说一句话\n\n---\n";
check("两条 --- 但没有 key:value → 不当元数据", parseSkillMd(hrOnly).body === hrOnly, "");

// ---------- ⑥ stripSkillMeta：把脏数据洗干净 ----------
const dirtyLegacy = "---\nname: broken\ntitle: 脏数据\n---\n\n## 正文\n内容\n";
check("stripSkillMeta 能洗掉老格式残留", !hasMetaInBody(stripSkillMeta(dirtyLegacy)) && stripSkillMeta(dirtyLegacy).startsWith("## 正文"), JSON.stringify(stripSkillMeta(dirtyLegacy).slice(0, 16)));
check("stripSkillMeta 能洗掉注释残留", !hasMetaInBody(stripSkillMeta(doc)), "");
check("已经干净的正文经过 strip 不变", stripSkillMeta("## 正文\n内容\n") === "## 正文\n内容\n", "");
// 真实的历史脏数据形态：注释块里**又套着**一层老 frontmatter（反复保存就会变成这样）
const nested = "<!-- qingniao-skill\nname: a\ntitle: A\n-->\n\n" + dirtyLegacy;
check(
  "两份元数据叠加（注释块里还套着老 frontmatter）也能洗干净",
  !hasMetaInBody(stripSkillMeta(nested)) && stripSkillMeta(nested).startsWith("## 正文"),
  JSON.stringify(stripSkillMeta(nested).slice(0, 20))
);

console.log(`\n===== 技能格式：${pass}/${pass + fail} 通过 =====`);
process.exit(fail ? 1 : 0);