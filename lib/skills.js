// 技能：Markdown(frontmatter) 解析/序列化 + 在线技能市场的拉取。
//
// 这里**只有纯逻辑**（不碰 chrome.*），方便在页面、service worker、以及 Node 脚本里复用。
// 存储相关的部分在 lib/storage.js。
//
// ⚠️ frontmatter 的解析规则在 market/build-index.mjs 里有一份等价实现（那个脚本要能脱离
//    扩展单独跑）。改规则时两处一起改。

export const DEFAULT_MARKET_SOURCE = "https://raw.githubusercontent.com/wangyemen/qingniao/main/market";
export const DEFAULT_MARKET_REPO = "https://github.com/wangyemen/qingniao";

// 去掉首尾引号
function unquote(v) {
  const s = String(v == null ? "" : v).trim();
  if (/^".*"$/.test(s) || /^'.*'$/.test(s)) return s.slice(1, -1);
  return s;
}

function parseValue(raw) {
  const s = String(raw == null ? "" : raw).trim();
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

// 解析 SKILL.md：返回 { meta, body }
export function parseSkillMd(text) {
  const src = String(text || "");
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(src);
  if (!m) return { meta: {}, body: src };
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
  return { meta, body: src.slice(m[0].length) };
}

function yamlValue(v) {
  if (Array.isArray(v)) return "[" + v.map((x) => String(x)).join(", ") + "]";
  const s = String(v == null ? "" : v);
  if (!s) return "";
  // 需要引号的情况：含 : # 或首尾空格
  if (/[:#]/.test(s) || /^\s|\s$/.test(s)) return JSON.stringify(s);
  return s;
}

// 序列化回 SKILL.md（保持字段顺序，便于人和 git diff 阅读）
export function stringifySkillMd(meta, body) {
  const order = ["name", "title", "description", "version", "author", "tags", "icon"];
  const keys = [...order.filter((k) => meta && meta[k] !== undefined && meta[k] !== ""), ...Object.keys(meta || {}).filter((k) => !order.includes(k) && meta[k] !== undefined && meta[k] !== "")];
  const head = keys.map((k) => `${k}: ${yamlValue(meta[k])}`).join("\n");
  const b = String(body || "").replace(/^\s*\n+/, "");
  return `---\n${head}\n---\n\n${b}${b.endsWith("\n") ? "" : "\n"}`;
}

// 把用户填的各种来源统一成"市场目录的 raw 地址"。
// 支持：仓库地址 / tree 地址 / blob 地址 / raw 地址 / 已经是市场目录的地址 / "owner/repo"
export function normalizeMarketSource(input) {
  let s = String(input || "").trim().replace(/\/+$/, "");
  if (!s) return { base: DEFAULT_MARKET_SOURCE, repo: DEFAULT_MARKET_REPO, changed: true };

  // owner/repo 简写
  if (/^[\w.-]+\/[\w.-]+$/.test(s) && !/^https?:/i.test(s)) {
    return {
      base: `https://raw.githubusercontent.com/${s}/main/market`,
      repo: `https://github.com/${s}`,
      changed: true,
    };
  }

  let m;
  // https://github.com/owner/repo/tree/branch/path...
  if ((m = /^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/tree\/([^/]+)(?:\/(.*))?$/i.exec(s))) {
    const path = (m[4] || "market").replace(/^\/+|\/+$/g, "");
    return {
      base: `https://raw.githubusercontent.com/${m[1]}/${m[2]}/${m[3]}/${path}`,
      repo: `https://github.com/${m[1]}/${m[2]}`,
      changed: true,
    };
  }
  // https://github.com/owner/repo/blob/branch/path/file.md → 回到所在目录
  if ((m = /^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/blob\/([^/]+)\/(.*)$/i.exec(s))) {
    const dir = m[4].replace(/\/[^/]*$/, "");
    return {
      base: `https://raw.githubusercontent.com/${m[1]}/${m[2]}/${m[3]}/${dir}`,
      repo: `https://github.com/${m[1]}/${m[2]}`,
      changed: true,
    };
  }
  // https://github.com/owner/repo  → 默认 main 分支下的 market/
  if ((m = /^https?:\/\/github\.com\/([^/]+)\/([^/]+)$/i.exec(s))) {
    return {
      base: `https://raw.githubusercontent.com/${m[1]}/${m[2]}/main/market`,
      repo: `https://github.com/${m[1]}/${m[2]}`,
      changed: true,
    };
  }
  // 已经是 raw 地址（含 raw.githubusercontent.com 或任意自建地址）→ 直接用
  if (/^https?:\/\//i.test(s)) {
    return { base: s, repo: s.replace(/\/[^/]*$/, ""), changed: false };
  }
  return { base: DEFAULT_MARKET_SOURCE, repo: DEFAULT_MARKET_REPO, changed: true };
}

// 拉取市场目录
export async function fetchMarketIndex(sourceInput, { signal } = {}) {
  const norm = normalizeMarketSource(sourceInput);
  const url = norm.base + "/index.json";
  const res = await fetch(url, { signal, cache: "no-cache" });
  if (!res.ok) {
    throw new Error(`读取技能目录失败：HTTP ${res.status}（${url}）`);
  }
  let data;
  try {
    data = await res.json();
  } catch (_) {
    throw new Error("技能目录不是合法的 JSON：" + url);
  }
  const raw = Array.isArray(data) ? data : data && data.skills;
  if (!Array.isArray(raw)) throw new Error("技能目录里没有 skills 列表：" + url);
  const skills = raw
    .map((s) => ({
      id: String(s.id || s.name || "").trim(),
      title: String(s.title || s.id || "").trim(),
      description: String(s.description || "").trim(),
      version: String(s.version || "0.0.0").trim(),
      author: String(s.author || "").trim(),
      tags: Array.isArray(s.tags) ? s.tags.map(String) : [],
      icon: String(s.icon || "").trim(),
      file: String(s.file || (s.id ? `skills/${s.id}/SKILL.md` : "")).trim(),
      path: String(s.path || "").trim(),
    }))
    .filter((s) => s.id && s.file);
  return { index: { ...(Array.isArray(data) ? {} : data), skills }, base: norm.base, repo: norm.repo, url, count: skills.length };
}

// 拉取某个技能的 SKILL.md 原文
export async function fetchSkillMd(base, skill, { signal } = {}) {
  const file = skill && skill.file ? skill.file : `skills/${skill.id}/SKILL.md`;
  const url = String(base).replace(/\/+$/, "") + "/" + file.replace(/^\/+/, "");
  const res = await fetch(url, { signal, cache: "no-cache" });
  if (!res.ok) throw new Error(`下载技能失败：HTTP ${res.status}（${url}）`);
  const text = await res.text();
  if (!/^---/.test(text.trim())) {
    // 没有 frontmatter 也允许，但要用目录里的元数据补齐
    return { text, url, guessed: true };
  }
  return { text, url, guessed: false };
}

// 本地技能对象：把市场条目 + 正文合成一份可用的技能
export function makeSkill({ meta, body, fallbackId }) {
  const id = String((meta && meta.name) || fallbackId || "").trim();
  return {
    id,
    title: String((meta && meta.title) || id).trim(),
    description: String((meta && meta.description) || "").trim(),
    version: String((meta && meta.version) || "0.0.0").trim(),
    author: String((meta && meta.author) || "").trim(),
    tags: Array.isArray(meta && meta.tags) ? meta.tags.map(String) : [],
    icon: String((meta && meta.icon) || "").trim(),
    body: String(body || "").trim(),
  };
}

// 版本比较（简单的 x.y.z 数字比较；不同长度按 0 补）
export function compareVersion(a, b) {
  const pa = String(a || "0").split(/[.\-+]/).map((x) => parseInt(x, 10) || 0);
  const pb = String(b || "0").split(/[.\-+]/).map((x) => parseInt(x, 10) || 0);
  const n = Math.max(pa.length, pb.length);
  for (let i = 0; i < n; i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d > 0 ? 1 : -1;
  }
  return 0;
}

// 把技能正文整理成"发给 AI"的一段话（用于侧栏点技能直接用）
export function buildSkillPrompt(skill, userExtra) {
  const extra = String(userExtra || "").trim();
  return (
    `【使用技能：${skill.title || skill.id}（v${skill.version || "?"}）】\n` +
    `下面是这个技能的说明书，请严格按它执行：\n\n` +
    `${skill.body || ""}\n\n` +
    (extra ? `【本次具体要求】${extra}\n` : `【本次具体要求】按上面的技能说明，针对当前页面开始执行。\n`) +
    `（若技能说明与当前页面情况不符，先说明情况再决定怎么做，不要硬套。）`
  );
}