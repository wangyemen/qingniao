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

// ⚠️ 为什么要多来源：raw.githubusercontent.com 在国内经常**完全连不上**（实测超时），
//    而 jsDelivr（Cloudflare / Fastly）可用性好得多；但 jsDelivr 对 `@main` 这类**分支地址**
//    会缓存最多 12 小时 —— 刚加的技能、刚改的 version.txt 都看不到。
//    所以顺序是：**GitHub API（实时）→ jsDelivr → jsDelivr/Fastly → 官方 raw**。
//    改顺序记得同步更新 UI 上的"来源"提示。
export const MIRROR_LABELS = {
  api: "GitHub API（实时）",
  jsdelivr: "jsDelivr 镜像",
  jsdelivrFastly: "jsDelivr（Fastly）镜像",
  raw: "GitHub 原始地址",
  custom: "自定义来源",
};

// GitHub API 的 contents 地址（实时；配 Accept: raw 拿到的是文件原文）
function apiContentsUrl(repos, path, cacheBust) {
  if (!repos || !repos.owner || !repos.name) return "";
  const p = String(path || "").replace(/^\/+/, "");
  const u = `https://api.github.com/repos/${repos.owner}/${repos.name}/contents/${p}?ref=${repos.branch || "main"}`;
  return cacheBust ? u + "&t=" + Date.now() : u;
}

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
//
// 两种来源：
//   · GitHub 仓库地址（官方市场）→ 展开成几条镜像，目录是 <base>/index.json
//   · **直接给一个目录接口地址**（用户市场：https://qingniao.gt.tc/api/market.php）
//     → 就用它本身当目录地址（不再拼 /index.json ✗），技能正文由接口里的绝对地址给出 ✓
export function isDirectIndexUrl(input) {
  const s = String(input || "").trim();
  if (!/^https?:\/\//i.test(s)) return false;
  if (/^https?:\/\/github\.com\//i.test(s)) return false;
  if (/(?:cdn|fastly)\.jsdelivr\.net|raw\.githubusercontent\.com/i.test(s)) return false;
  return /\.(php|json|cgi)(\?|$)/i.test(s) || /\/(api|market)(\/|$)/i.test(s);
}

export function marketCandidates(input) {
  const repos = parseRepo(input);
  const raw = String(input || "").trim().replace(/\/+$/, "");
  if (!repos) {
    // 自建/用户市场：源本身就是"目录地址"
    const base = raw || DEFAULT_MARKET_SOURCE;
    return [{ base, label: MIRROR_LABELS.custom, direct: isDirectIndexUrl(raw) }];
  }
  const { owner, name, branch, dir } = repos;
  const seg = "/" + dir;
  return [
    { base: jsdelivrRepo("cdn.jsdelivr.net", owner, name, branch, seg), label: MIRROR_LABELS.jsdelivr },
    { base: jsdelivrRepo("fastly.jsdelivr.net", owner, name, branch, seg), label: MIRROR_LABELS.jsdelivrFastly },
    { base: `https://raw.githubusercontent.com/${owner}/${name}/${branch}${seg}`, label: MIRROR_LABELS.raw },
  ];
}

// 仓库里某个文件的候选地址（version.txt 这类用）：**API 优先**（实时），镜像兜底
export function fileCandidates(input, repoPath) {
  const repos = parseRepo(input);
  const p = String(repoPath || "").replace(/^\/+/, "");
  if (!repos) return [];
  const { owner, name, branch } = repos;
  const out = [];
  const api = apiContentsUrl(repos, p, false);
  if (api) out.push({ url: api, label: MIRROR_LABELS.api, headers: { Accept: "application/vnd.github.raw" } });
  out.push(
    { url: jsdelivrRepo("cdn.jsdelivr.net", owner, name, branch, "/" + p), label: MIRROR_LABELS.jsdelivr },
    { url: jsdelivrRepo("fastly.jsdelivr.net", owner, name, branch, "/" + p), label: MIRROR_LABELS.jsdelivrFastly },
    { url: `https://raw.githubusercontent.com/${owner}/${name}/${branch}/${p}`, label: MIRROR_LABELS.raw }
  );
  return out;
}

// 依次试候选地址，返回第一个成功的文本（附带实际用的地址与来源名）
// 候选可以带自己的 headers（比如 GitHub API 要 Accept: raw 才给文件原文）
// 每个候选失败后**再给一次机会**（CDN 抖动/被限流很常见，重试一次往往就好了）
export async function fetchFirstText(candidates, { signal, cacheBust } = {}) {
  const tried = [];
  let lastErr = null;
  for (const c of candidates) {
    const url = cacheBust ? c.url + (c.url.includes("?") ? "&" : "?") + "t=" + Date.now() : c.url;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const res = await fetch(url, { signal, cache: "no-cache", headers: c.headers || undefined });
        if (!res.ok) {
          if (res.status >= 500 && attempt === 0) {
            await new Promise((r) => setTimeout(r, 800));
            continue;
          }
          tried.push(`${c.label} HTTP ${res.status}`);
          lastErr = new Error(`${c.label} 返回 HTTP ${res.status}`);
          break;
        }
        const text = await res.text();
        return { text, url: c.url, label: c.label, tried };
      } catch (err) {
        if (attempt === 0) {
          await new Promise((r) => setTimeout(r, 800));
          continue;
        }
        tried.push(`${c.label} 连接失败`);
        lastErr = err;
      }
    }
  }
  const detail = tried.length ? "（已尝试：" + tried.join("、") + "）" : "";
  const e = new Error("所有来源都拉不到内容" + detail);
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

// ===== 技能文件里的"元数据块" =====
//
// 为什么要换格式：原来用 Markdown 的 `---` frontmatter，但它**和 Markdown 语法打架** ——
//   · 开头一个 `---` 会被渲染成一条水平线，元数据文字直接显示在正文里；
//   · 解析只要稍微不标准就整块失效（实测：文件开头多个 BOM、或一个空行，就会把整块
//     元数据当成正文收进编辑框，用户报过这个问题）。
// 现在导出改用 **HTML 注释** 包起来：
//   <!-- qingniao-skill
//   name: xxx
//   title: 显示名
//   -->
// 注释在任何 Markdown / HTML 渲染里都**不会显示** ✓，也不会被 Markdown 语法吃掉 ✓，
// 别的工具拿到文件直接忽略 ✓，而我们的导入能用一个独特标记可靠地认出来 ✓。
// 导入仍然**兼容**老格式（`---` frontmatter）—— 技能市场里那批 SKILL.md 都是老格式。
export const SKILL_META_OPEN = "<!-- qingniao-skill";
export const SKILL_META_CLOSE = "-->";

// 把开头的元数据块剥掉，只留正文（顺带去掉紧跟其后的空行）。
// 只在"确实像元数据"时才剥（含 name/title/description 这类键），避免误伤正文里正常的分隔线。
// 循环剥几次：历史脏数据可能是"注释块 + 老 frontmatter"叠在一起（越改越乱的那种）。
export function stripSkillMeta(text) {
  let cur = String(text == null ? "" : text);
  for (let i = 0; i < 4; i++) {
    const r = parseSkillMd(cur);
    if (r.form === "none") break;
    const next = r.body.replace(/^[ \t]*\r?\n+/, "");
    if (!next.trim() || next === cur) break;
    cur = next;
  }
  return cur;
}

// 认元数据块：返回 { meta, body, form } —— form 是 'comment' | 'frontmatter' | 'none'
export function parseSkillMd(text) {
  const src = String(text || "");
  // 容忍 BOM、开头空行/空白（很多编辑器、下载工具会给文件加这些）
  const lead = /^\uFEFF?[\s]*/.exec(src)[0].length;
  const after = src.slice(lead);

  const meta = {};
  const readPairs = (block) => {
    let lastKey = null;
    for (const raw of block.split(/\r?\n/)) {
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
    return meta;
  };

  // ① 新格式：<!-- qingniao-skill … -->
  if (after.startsWith(SKILL_META_OPEN)) {
    const rest = after.slice(SKILL_META_OPEN.length);
    const end = rest.indexOf(SKILL_META_CLOSE);
    if (end >= 0) {
      readPairs(rest.slice(0, end));
      const body = rest.slice(end + SKILL_META_CLOSE.length).replace(/^[\s]*\n/, "");
      return { meta, body, form: "comment" };
    }
  }

  // ② 老格式：--- frontmatter ---（也容忍 `...` 收尾、结尾 fence 后有空格）
  const fm = /^---[ \t]*\r?\n([\s\S]*?)\r?\n(?:---|\.\.\.)[ \t]*\r?\n?/.exec(after);
  if (fm) {
    readPairs(fm[1]);
    // ⚠️ 只有"确实像元数据"（解析出了至少一个 key: value）才当元数据剥掉，
    //    否则正文里随便一个 `---` 分隔线就会被误吞（宁可不动，也不误伤）。
    if (Object.keys(meta).length) return { meta, body: after.slice(fm[0].length), form: "frontmatter" };
  }

  // ③ 没有元数据块
  return { meta: {}, body: src, form: "none" };
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
// ⚠️ 这是**老格式**（`---` frontmatter）。普通导出请用下面的 stringifySkillDoc。
export function stringifySkillMd(meta, body) {
  const order = ["name", "title", "description", "version", "author", "tags", "icon"];
  const keys = [...order.filter((k) => meta && meta[k] !== undefined && meta[k] !== ""), ...Object.keys(meta || {}).filter((k) => !order.includes(k) && meta[k] !== undefined && meta[k] !== "")];
  const head = keys.map((k) => `${k}: ${yamlValue(meta[k])}`).join("\n");
  const b = String(body || "").replace(/^\s*\n+/, "");
  return `---\n${head}\n---\n\n${b}${b.endsWith("\n") ? "" : "\n"}`;
}

// 序列化成**新格式**：元数据放在 HTML 注释里（Markdown 渲染不会显示它，也不会被语法吃掉）
export function stringifySkillDoc(meta, body) {
  const order = ["name", "title", "description", "version", "author", "tags", "icon"];
  const keys = [
    ...order.filter((k) => meta && meta[k] !== undefined && meta[k] !== ""),
    ...Object.keys(meta || {}).filter((k) => !order.includes(k) && meta[k] !== undefined && meta[k] !== ""),
  ];
  const head = keys.map((k) => `${k}: ${yamlValue(meta[k])}`).join("\n");
  // 正文里若还残留元数据块（历史脏数据/用户粘贴），先剥掉 —— 免得出现两份
  const b = stripSkillMeta(body).replace(/^\s*\n+/, "");
  return `${SKILL_META_OPEN}\n${head}\n${SKILL_META_CLOSE}\n\n${b}${b.endsWith("\n") ? "" : "\n"}`;
}

// 拉取市场目录（**实时 API 优先**，多镜像兜底）
export async function fetchMarketIndex(sourceInput, { signal } = {}) {
  const repos = parseRepo(sourceInput);
  const candidates = [];
  const cands = marketCandidates(sourceInput);
  const direct = cands.length === 1 && cands[0].direct;

  // ① GitHub API：实时（否则 jsDelivr 的分支缓存会让新技能最多晚 12 小时才出现）
  const api = direct ? "" : apiContentsUrl(repos, "index.json", false);
  if (api) candidates.push({ url: api, label: MIRROR_LABELS.api, headers: { Accept: "application/vnd.github.raw" } });
  // ② 镜像 / 或"直给的目录接口地址"
  for (const c of cands) {
    candidates.push({
      url: c.direct ? c.base : c.base.replace(/\/+$/, "") + "/index.json",
      label: c.label,
    });
  }

  const hit = await fetchFirstText(candidates, { signal, cacheBust: true });
  let data;
  try {
    data = JSON.parse(hit.text);
  } catch (_) {
    throw new Error(`技能目录不是合法的 JSON（来自 ${hit.label}）`);
  }
  // API 没带 Accept: raw 时会给 JSON{content: base64}；这里兜一层解码
  if (data && !Array.isArray(data) && !Array.isArray(data.skills) && data.content) {
    try {
      const bin = atob(String(data.content).replace(/\s+/g, ""));
      const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
      data = JSON.parse(new TextDecoder("utf-8").decode(bytes));
    } catch (_) {}
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
      // 用户市场会带上 market:"user"（官方目录没有这个字段）→ 用来打"未官方审核"标记
      market: String(s.market || "").trim(),
      downloads: Number(s.downloads) || 0,
      updatedAt: String(s.updatedAt || "").trim(),
    }))
    .filter((s) => s.id && s.file);

  // 记住这次成功的那条来源；并把所有来源都保留下来，供"下载技能正文"时兜底。
  // ⚠️ API 的"基址"要用**市场目录**的 contents 地址（不是 index.json 那个），
  //    否则拼出来的正文地址会少一层目录；并且它必须带 Accept: raw 才拿到文件原文。
  const apiDirBase = apiContentsUrl(repos, repos ? repos.dir || "market" : "", false);
  const built = [];
  if (apiDirBase) built.push({ base: apiDirBase, label: MIRROR_LABELS.api, headers: { Accept: "application/vnd.github.raw" } });
  for (const c of marketCandidates(sourceInput)) {
    built.push({ base: c.base.replace(/\/+$/, ""), label: c.label });
  }
  const usedBase = hit.url.replace(/\/index\.json.*$/, "").replace(/\?.*$/, "");
  const bases = built
    .map((b) => ({ ...b, base: b.base.replace(/\?.*$/, "") }))
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

// 拉取某个技能的 SKILL.md 原文（bases 给多条来源时会依次兜底）
//
// ⚠️ file 可以是**绝对地址** —— 用户市场（官网接口）就是这么给的：
//    "file": "https://qingniao.gt.tc/api/skill.php?id=12"
//    这种情况直接用这个地址取，不再拼 base ✓（官方市场仍然是相对路径 ✓）
export async function fetchSkillMd(baseOrBases, skill, { signal } = {}) {
  const file = skill && skill.file ? String(skill.file) : `skills/${skill.id}/SKILL.md`;
  const bases = Array.isArray(baseOrBases)
    ? baseOrBases.map((b) => (typeof b === "string" ? { base: b, label: MIRROR_LABELS.custom } : b))
    : [{ base: baseOrBases, label: MIRROR_LABELS.custom }];

  const candidates = [];
  if (/^https?:\/\//i.test(file)) {
    candidates.push({ url: file, label: MIRROR_LABELS.custom });
  }
  for (const b of bases) {
    candidates.push({
      url: String(b.base).replace(/\/+$/, "") + "/" + file.replace(/^\/+/, ""),
      label: b.label,
      headers: b.headers || undefined,
    });
  }

  const hit = await fetchFirstText(candidates, { signal });
  const text = hit.text;
  return {
    text,
    url: hit.url,
    label: hit.label,
    // 新格式（注释块）与老格式（---）都算"不是靠猜的"
    guessed: !/^(?:<!--\s*qingniao-skill|\uFEFF?\s*---)/.test(text.trim()),
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