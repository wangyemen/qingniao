#!/usr/bin/env node
// 生成 market/index.json（技能目录）。
//
// 用法： node market/build-index.mjs
//
// 说明：这里**故意自己实现了一个极简 frontmatter 解析**，而不是复用 lib/skills.js ——
// 因为本脚本要能脱离扩展（纯 Node）直接跑，不依赖 Chrome API，也不引入任何依赖包。
// 改动解析规则时，记得两处一起改（lib/skills.js / market/build-index.mjs）。

import { readdirSync, readFileSync, writeFileSync, statSync, existsSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(HERE);
const SKILLS_DIR = join(HERE, "skills");

// 极简 frontmatter：只支持 key: value、key: [a, b]、key 后面的 "- " 列表
function parseFrontmatter(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (!m) return { meta: {}, body: text };
  const meta = {};
  let lastKey = null;
  for (const raw of m[1].split(/\r?\n/)) {
    const line = raw.trimEnd();
    if (!line.trim() || line.trim().startsWith("#")) continue;
    const listItem = /^\s*-\s+(.*)$/.exec(line);
    if (listItem && lastKey) {
      if (!Array.isArray(meta[lastKey])) meta[lastKey] = [];
      meta[lastKey].push(unquote(listItem[1]));
      continue;
    }
    const kv = /^([A-Za-z0-9_\-.]+)\s*:\s*(.*)$/.exec(line);
    if (!kv) continue;
    lastKey = kv[1];
    meta[lastKey] = parseValue(kv[2]);
  }
  return { meta, body: text.slice(m[0].length) };
}

function unquote(v) {
  const s = String(v).trim();
  if (/^".*"$/.test(s) || /^'.*'$/.test(s)) return s.slice(1, -1);
  return s;
}

function parseValue(v) {
  const s = String(v).trim();
  if (!s) return "";
  const arr = /^\[(.*)\]$/.exec(s);
  if (arr) {
    return arr[1]
      .split(",")
      .map((x) => unquote(x))
      .filter((x) => x.length);
  }
  return unquote(s);
}

function collect() {
  if (!existsSync(SKILLS_DIR)) return [];
  const out = [];
  for (const entry of readdirSync(SKILLS_DIR).sort()) {
    const dir = join(SKILLS_DIR, entry);
    if (!statSync(dir).isDirectory()) continue;
    const file = join(dir, "SKILL.md");
    if (!existsSync(file)) continue;
    const text = readFileSync(file, "utf8");
    const { meta, body } = parseFrontmatter(text);
    const id = String(meta.name || entry).trim();
    if (!id) continue;
    const path = relative(ROOT, file).replace(/\\/g, "/");
    out.push({
      id,
      title: meta.title || id,
      description: meta.description || "",
      version: String(meta.version || "0.0.0"),
      author: meta.author || "",
      tags: Array.isArray(meta.tags) ? meta.tags : [],
      icon: meta.icon || "",
      // file 是"相对市场目录"的路径（扩展用它拼 URL），path 是仓库内的完整路径（给人看）
      file: `skills/${entry}/SKILL.md`,
      path,
      bytes: Buffer.byteLength(text, "utf8"),
      lines: body.split(/\r?\n/).filter((l) => l.trim()).length,
    });
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

const skills = collect();
const index = {
  schema: 1,
  generatedAt: new Date().toISOString(),
  repo: "https://github.com/wangyemen/qingniao",
  count: skills.length,
  skills,
};

writeFileSync(join(HERE, "index.json"), JSON.stringify(index, null, 2) + "\n", "utf8");
console.log(`已生成 market/index.json —— ${skills.length} 个技能`);
for (const s of skills) console.log(`  ${s.id.padEnd(16)} ${s.title}  v${s.version}`);