// 技能：Markdown(frontmatter) 解析/序列化 + 在线技能市场的拉取。
//
// 这里**只有纯逻辑**（不碰 chrome.*），方便在页面、service worker、以及 Node 脚本里复用。
// 存储相关的部分在 lib/storage.js。
//
// ⚠️ frontmatter 的解析规则在 market/build-index.mjs 里有一份等价实现（那个脚本要能脱离
//    扩展单独跑）。改规则时两处一起改。

export const DEFAULT_MARKET_REPO = "https://github.com/wangyemen/qingniao";
// 默认给"仓库地址"，内部会自动展开成多条镜像（见 marketCandidates）
export const DEFAULT_MARKET_SOURCE = "https://github.com/wangyemen/qingniao";

// ⚠️ 为什么要多镜像：raw.githubusercontent.com 在国内经常**完全连不上**（实测超时），
//    而 jsDelivr（Cloudflare / Fastly）可用性好得多。所以默认优先走 jsDelivr，
//    官方 raw 只作为最后兜底。换源顺序改了的话，记得同步更新 UI 上的"来源"提示。
export const MIRROR_LABELS = {
  jsdelivr: "jsDelivr 镜像",
  jsdelivrFastly: "jsDelivr（Fastly）镜像",
  raw: "GitHub 原始地址",
  custom: "自定义来源",
};

function jsdelivrRepo(host, owner, name, branch, pathWithSlash) {
  return `https://${host}/gh/${owner}/${name}@${branch}${pathWithSlash}`;
}

// 把用户填的各种来源解析成仓库信息（能解析出 owner/repo 才能生成镜像）
export function parseRepo(input) {
  const s = String(input || "").trim().replace(/\/+$/, "");
  if (!s) return null;
  let m;

  // owner/repo 简写
  if (/^[\w.-]+\/[\w.-]+$/.test(s) && !/^https?:/i.test(s)) {
    const [owner, name] = s.split("/");
    return { owner, name, branch: "main", dir: "market", repo: `https://github.com/${owner}/${name}` };
  }
  // github.com/owner/repo(/tree/branch(/dir)|/blob/branch/rest)
  if ((m = /^https?:\/\/(?:www\.)?github\.com\/([^/]+)\/([^/]+?)(?:\.git)?(?:\/(tree|blob)\/([^/]+)(?:\/(.*))?)?$/i.exec(s))) {
    const owner = m[1];
    const name = m[2];
    const kind = m[3];
    const branch = m[4] || "main";
    let dir = "market";
    if (kind === "tree") dir = (m[5] || "market").replace(/\/+$/, "");
    else if (kind === "blob") dir = (m[5] || "").replace(/\/[^/]*$/, "");
    return { owner, name, branch, dir, repo: `https://github.com/${owner}/${name}` };
  }
  // raw.githubusercontent.com/owner/repo/branch(/dir)
  if ((m = /^https?:\/\/raw\.githubusercontent\.com\/([^/]+)\/([^/]+)\/([^/]+)(?:\/(.*))?$/i.exec(s))) {
    return {
      owner: m[1],
      name: m[2],
      branch: m[3],
      dir: (m[4] || "market").replace(/\/+$/, ""),
      repo: `https://github.com/${m[1]}/${m[2]}`,
    };
  }
  // cdn.jsdelivr.net/gh/owner/repo@branch(/dir)
  if ((m = /^https?:\/\/(?:cdn|fastly)\.jsdelivr\.net\/gh\/([^/]+)\/([^/@]+)@([^/]+)(?:\/(.*))?$/i.exec(s))) {
    return {
      owner: m[1],
      name: m[2],
      branch: m[3],
      dir: (m[4] || "market").replace(/\/+$/, ""),
      repo: `https://github.com/${m[1]}/${m[2]}`,
    };
  }
  return null;
}

// 市场目录的候选地址（按可用性从好到差）
export function marketCandidates(input) {
  const repos = parseRepo(input);
  const raw = String(input || "").trim().replace(/\/+$/, "");
  if (!repos) {
    // 自定义来源（自建市场等）：只用它自己
    const base = raw || DEFAULT_MARKET_SOURCE;
    return [{ base, label: MIRROR_LABELS.custom }];
  }
  const { owner, name, branch, dir } = repos;
  const seg = "/" + dir;
  return [
    { base: jsdelivrRepo("cdn.jsdelivr.net", owner, name, branch, seg), label: MIRROR_LABELS.jsdelivr },
    { base: jsdelivrRepo("fastly.jsdelivr.net", owner, name, branch, seg), label: MIRROR_LABELS.jsdelivrFastly },
    { base: `https://raw.githubusercontent.com/${owner}/${name}/${branch}${seg}`, label: MIRROR_LABELS.raw },
  ];
}

// 仓库里某个文件的候选地址（version.txt 这类用）
export function fileCandidates(input, repoPath) {
  const repos = parseRepo(input);
  const p = String(repoPath || "").replace(/^\/+/, "");
  if (!repos) return [];
  const { owner, name, branch } = repos;
  return [
    { url: jsdelivrRepo("cdn.jsdelivr.net", owner, name, branch, "/" + p), label: MIRROR_LABELS.jsdelivr },
    { url: jsdelivrRepo("fastly.jsdelivr.net", owner, name, branch, "/" + p), label: MIRROR_LABELS.jsdelivrFastly },
    { url: `https://raw.githubusercontent.com/${owner}/${name}/${branch}/${p}`, label: MIRROR_LABELS.raw },
  ];
}

// 依次试候选地址，返回第一个成功的文本（附带实际用的地址与来源名）
export async function fetchFirstText(candidates, { signal, cacheBust } = {}) {
  const tried = [];
  let lastErr = null;
  for (const c of candidates) {
    const url = cacheBust ? c.url + (c.url.includes("?") ? "&" : "?") + "t=" + Date.now() : c.url;
    try {
      const res = await fetch(url, { signal, cache: "no-cache" });
      if (!res.ok) {
        tried.push(`${c.label} HTTP ${res.status}`);
        lastErr = new Error(`${c.label} 返回 HTTP ${res.status}`);
        continue;
      }
      const text = await res.text();
      return { text, url: c.url, label: c.label, tried };
    } catch (err) {
      tried.push(`${c.label} 连接失败`);
      lastErr = err;
    }
  }
  const detail = tried.length ? "（已尝试：" + tried.join("、") + "）" : "";
  const e = new Error("所有镜像都拉不到内容" + detail);
  e.cause = lastErr;
  e.tried = tried;
  throw e;
}

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

// 拉取市场目录（自动在多镜像间兜底）
export async function fetchMarketIndex(sourceInput, { signal } = {}) {
  const candidates = marketCandidates(sourceInput).map((c) => ({
    url: c.base.replace(/\/+$/, "") + "/index.json",
    label: c.label,
  }));
  const hit = await fetchFirstText(candidates, { signal, cacheBust: true });
  let data;
  try {
    data = JSON.parse(hit.text);
  } catch (_) {
    throw new Error(`技能目录不是合法的 JSON（来自 ${hit.label}）`);
  }
  const raw = Array.isArray(data) ? data : data && data.skills;
  if (!Array.isArray(raw)) throw new Error(`技能目录里没有 skills 列表（来自 ${hit.label}）`);
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

  // 记住这次成功的那条镜像，并保留其余候选，供下载正文时兜底
  const usedBase = hit.url.replace(/\/index\.json.*$/, "");
  const bases = candidates
    .map((c) => ({ base: c.url.replace(/\/index\.json.*$/, ""), label: c.label }))
    .sort((a, b) => (a.base === usedBase ? -1 : b.base === usedBase ? 1 : 0));

  return {
    index: { ...(Array.isArray(data) ? {} : data), skills },
    base: usedBase,
    bases,
    label: hit.label,
    tried: hit.tried,
    repo: (parseRepo(sourceInput) || {}).repo || "",
    url: hit.url,
    count: skills.length,
  };
}

// 拉取某个技能的 SKILL.md 原文（bases 给多条镜像时会依次兜底）
export async function fetchSkillMd(baseOrBases, skill, { signal } = {}) {
  const file = skill && skill.file ? skill.file : `skills/${skill.id}/SKILL.md`;
  const bases = Array.isArray(baseOrBases)
    ? baseOrBases.map((b) => (typeof b === "string" ? { base: b, label: MIRROR_LABELS.custom } : b))
    : [{ base: baseOrBases, label: MIRROR_LABELS.custom }];
  const candidates = bases.map((b) => ({
    url: String(b.base).replace(/\/+$/, "") + "/" + String(file).replace(/^\/+/, ""),
    label: b.label,
  }));
  const hit = await fetchFirstText(candidates, { signal });
  const text = hit.text;
  return {
    text,
    url: hit.url,
    label: hit.label,
    guessed: !/^---/.test(text.trim()),
  };
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