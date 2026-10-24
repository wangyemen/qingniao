// 技能市场（嵌在设置页里）：浏览在线技能、装到本地、管理/编辑自己的技能、看更新日志。
//
// 数据流：市场 index.json（GitHub raw）→ 安装 → chrome.storage.local 的 ai_skills
// → 侧栏「技能」列表读同一份数据。这里不做任何需要后台权限的事。

import {
  loadSkills,
  upsertSkill,
  deleteSkill,
  setSkillEnabled,
  loadMarketSettings,
  saveMarketSettings,
} from "../lib/storage.js";
import {
  parseSkillMd,
  stringifySkillMd,
  makeSkill,
  fetchMarketIndex,
  fetchSkillMd,
  buildSkillPrompt,
  compareVersion,
  DEFAULT_MARKET_REPO,
} from "../lib/skills.js";
import { loadLocalVersionTxt } from "../lib/updates.js";
import { renderMarkdown } from "../lib/markdown.js";

const $ = (id) => document.getElementById(id);
const statusEl = $("marketStatus");

let skills = {};
let market = null;
let marketSource = "";
let editingId = null;

function setStatus(msg, kind) {
  if (!statusEl) return;
  statusEl.textContent = msg || "";
  statusEl.className = "status" + (kind ? " " + kind : "");
  if (msg) {
    clearTimeout(setStatus._t);
    setStatus._t = setTimeout(() => {
      statusEl.textContent = "";
      statusEl.className = "status";
    }, 5000);
  }
}

function fmtTime(ts) {
  if (!ts) return "—";
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

// ---------- 页内导航 ----------
function bindNav() {
  const items = [...document.querySelectorAll(".page-nav .nav-item")];
  const show = (pane) => {
    for (const it of items) it.classList.toggle("active", it.dataset.pane === pane);
    $("pane-settings").classList.toggle("hidden", pane !== "settings");
    $("pane-skills").classList.toggle("hidden", pane !== "skills");
    if (pane === "skills" && !market && !marketSource) fetchMarket({ silent: true });
    if (pane === "skills") loadChangelog();
  };
  for (const it of items) it.addEventListener("click", () => show(it.dataset.pane));
  // 支持从侧栏直接跳到技能市场：#skills
  if ((location.hash || "").replace("#", "") === "skills") show("skills");
  window.addEventListener("hashchange", () => {
    if ((location.hash || "").replace("#", "") === "skills") show("skills");
  });
}

// ---------- 在线市场 ----------
function bindMarket() {
  $("fetchBtn").addEventListener("click", () => fetchMarket({}));
  $("resetSourceBtn").addEventListener("click", () => {
    $("sourceInput").value = DEFAULT_MARKET_REPO;
    fetchMarket({});
  });
  $("marketSearch").addEventListener("input", renderMarket);
}

async function fetchMarket({ silent } = {}) {
  const input = $("sourceInput").value.trim() || DEFAULT_MARKET_REPO;
  marketSource = input;
  if (!silent) {
    $("marketMeta").textContent = "正在获取…";
    setStatus("正在从仓库获取技能目录…");
  }
  try {
    market = await fetchMarketIndex(input);
    await saveMarketSettings({
      source: input,
      repo: market.repo,
      lastSyncAt: Date.now(),
      lastCount: market.count,
      lastError: "",
    });
    $("marketMeta").textContent = `已同步 ${market.count} 个技能 · ${fmtTime(Date.now())} · 来源：${market.label}`;
    renderMarket();
    if (!silent) setStatus(`获取成功：${market.count} 个技能（${market.label}）`, "ok");
  } catch (err) {
    market = null;
    await saveMarketSettings({ source: input, lastError: String((err && err.message) || err) });
    $("marketMeta").textContent = "获取失败：" + ((err && err.message) || err);
    renderMarket();
    if (!silent) setStatus("获取失败：" + ((err && err.message) || err), "err");
  }
}

function renderMarket() {
  const box = $("marketList");
  box.innerHTML = "";
  if (!market) {
    box.appendChild(el("div", "empty", "还没有技能列表。点上方的「获取技能」从仓库拉取，或换一个来源地址。"));
    return;
  }
  const q = $("marketSearch").value.trim().toLowerCase();
  const list = market.index.skills.filter((s) => {
    if (!q) return true;
    return (
      s.id.toLowerCase().includes(q) ||
      s.title.toLowerCase().includes(q) ||
      s.description.toLowerCase().includes(q) ||
      s.tags.join(" ").toLowerCase().includes(q)
    );
  });
  if (!list.length) {
    box.appendChild(el("div", "empty", q ? "没有匹配的技能。" : "这个市场里还没有技能。"));
    return;
  }
  for (const m of list) box.appendChild(marketCard(m));
}

function marketCard(m) {
  const local = skills[m.id];
  const card = el("div", "card");

  const head = el("div", "card-head");
  head.appendChild(el("span", "card-icon", m.icon || "🧩"));
  head.appendChild(el("h3", "card-title", m.title));
  head.appendChild(el("span", "card-ver", "v" + m.version));
  card.appendChild(head);

  card.appendChild(el("p", "card-desc", m.description || "（作者没有写说明）"));

  const meta = el("div", "card-meta");
  if (m.author) meta.appendChild(el("span", "chip", "作者 " + m.author));
  for (const t of m.tags) meta.appendChild(el("span", "chip", t));
  card.appendChild(meta);

  const foot = el("div", "card-foot");
  const state = el("span", "state");
  if (local) {
    if (compareVersion(m.version, local.version) > 0) {
      state.textContent = `已装 v${local.version}，可更新到 v${m.version}`;
      state.className = "state warn";
    } else {
      state.textContent = `已装 v${local.version}${local.enabled === false ? "（已停用）" : ""}`;
      state.className = "state ok";
    }
  } else {
    state.textContent = "未安装";
  }
  foot.appendChild(state);

  const actions = el("div", "card-actions");
  const preview = el("button", "tiny", "预览");
  preview.addEventListener("click", () => previewMarketSkill(m));
  actions.appendChild(preview);

  const install = el("button", local ? "tiny" : "primary tiny", local ? "重新安装" : "安装到本地");
  install.addEventListener("click", () => installMarketSkill(m, install));
  actions.appendChild(install);

  const useNow = el("button", "tiny", "去侧栏用");
  useNow.addEventListener("click", () => {
    copySkillPromptFromMarket(m);
  });
  actions.appendChild(useNow);

  foot.appendChild(actions);
  card.appendChild(foot);
  return card;
}

async function copySkillPromptFromMarket(m) {
  const local = skills[m.id];
  if (!local) return setStatus("先安装这个技能，再到侧栏使用", "err");
  try {
    await navigator.clipboard.writeText(buildSkillPrompt(local));
    setStatus("已复制「发给 AI 的技能指令」：回到页面粘进侧栏输入框即可", "ok");
  } catch (_) {
    setStatus("复制失败，请到侧栏的技能列表里直接用", "err");
  }
}

async function previewMarketSkill(m) {
  try {
    setStatus("正在下载技能正文…");
    const { text } = await fetchSkillMd(market.bases || market.base, m);
    const { meta, body } = parseSkillMd(text);
    showPreviewDialog(makeSkill({ meta, body, fallbackId: m.id }));
    setStatus("");
  } catch (err) {
    setStatus("预览失败：" + ((err && err.message) || err), "err");
  }
}

async function installMarketSkill(m, btn) {
  try {
    if (btn) {
      btn.disabled = true;
      btn.textContent = "安装中…";
    }
    const { text, url } = await fetchSkillMd(market.bases || market.base, m);
    const { meta, body } = parseSkillMd(text);
    const skill = makeSkill({ meta, body, fallbackId: m.id });
    if (!skill.id) throw new Error("技能缺少 name 字段");
    const prev = skills[skill.id] || {};
    const saved = await upsertSkill({
      ...skill,
      title: skill.title || m.title,
      description: skill.description || m.description,
      icon: skill.icon || m.icon,
      tags: skill.tags && skill.tags.length ? skill.tags : m.tags,
      source: "market",
      enabled: prev.enabled !== false,
      marketUrl: url,
      marketSource: marketSource,
      marketVersion: m.version,
    });
    skills = await loadSkills();
    renderMarket();
    renderMine();
    setStatus(`已安装「${saved.title}」v${saved.version}，回侧栏点「技能」即可用`, "ok");
  } catch (err) {
    setStatus("安装失败：" + ((err && err.message) || err), "err");
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = skills[m.id] ? "重新安装" : "安装到本地";
    }
  }
}

// ---------- 我的技能 ----------
function bindMine() {
  $("newSkillBtn").addEventListener("click", startNewSkill);
  $("exportAllBtn").addEventListener("click", exportAll);
}

function renderMine() {
  const box = $("mineList");
  box.innerHTML = "";
  const list = Object.values(skills).sort(
    (a, b) => (b.updatedAt || b.installedAt || 0) - (a.updatedAt || a.installedAt || 0)
  );
  $("mineMeta").textContent = list.length
    ? `共 ${list.length} 个技能（${list.filter((s) => s.enabled !== false).length} 个已启用）。启用的技能会出现在侧栏的技能列表里。`
    : "还没有技能。去上面「在线市场」装几个，或在下面新建一个。";
  if (!list.length) {
    box.appendChild(el("div", "empty", "空空的。点「新建技能」写一个，或去在线市场安装。"));
    return;
  }
  for (const s of list) box.appendChild(mineCard(s));
}

function mineCard(s) {
  const card = el("div", "card");

  const head = el("div", "card-head");
  head.appendChild(el("span", "card-icon", s.icon || "🧩"));
  head.appendChild(el("h3", "card-title", s.title || s.id));
  head.appendChild(el("span", "card-ver", "v" + (s.version || "?")));
  card.appendChild(head);

  card.appendChild(el("p", "card-desc", s.description || "（没有说明）"));

  const meta = el("div", "card-meta");
  meta.appendChild(el("span", "chip", s.source === "market" ? "来自市场" : "自建"));
  if (s.author) meta.appendChild(el("span", "chip", "作者 " + s.author));
  for (const t of s.tags || []) meta.appendChild(el("span", "chip", t));
  card.appendChild(meta);

  const foot = el("div", "card-foot");
  foot.appendChild(el("span", "state " + (s.enabled === false ? "" : "ok"), s.enabled === false ? "已停用" : "已启用"));

  const actions = el("div", "card-actions");

  const toggle = el("button", "tiny", s.enabled === false ? "启用" : "停用");
  toggle.addEventListener("click", async () => {
    await setSkillEnabled(s.id, s.enabled === false);
    skills = await loadSkills();
    renderMine();
    setStatus((s.enabled === false ? "已启用：" : "已停用：") + (s.title || s.id), "ok");
  });
  actions.appendChild(toggle);

  const edit = el("button", "tiny", "编辑");
  edit.addEventListener("click", () => loadIntoEditor(s.id));
  actions.appendChild(edit);

  const preview = el("button", "tiny", "预览");
  preview.addEventListener("click", () => showPreviewDialog(s));
  actions.appendChild(preview);

  const exp = el("button", "tiny", "导出 .md");
  exp.addEventListener("click", () => downloadSkill(s));
  actions.appendChild(exp);

  const del = el("button", "tiny danger", "删除");
  del.addEventListener("click", async () => {
    if (!confirm(`删除技能「${s.title || s.id}」？只影响本机。`)) return;
    await deleteSkill(s.id);
    skills = await loadSkills();
    renderMarket();
    renderMine();
    setStatus("已删除：" + (s.title || s.id), "ok");
  });
  actions.appendChild(del);

  foot.appendChild(actions);
  card.appendChild(foot);
  return card;
}

async function exportAll() {
  const list = Object.values(skills);
  if (!list.length) return setStatus("没有可导出的技能", "err");
  for (const s of list) downloadSkill(s);
  setStatus(`已导出 ${list.length} 个 .md 文件`, "ok");
}

// ---------- 编辑器 ----------
function bindEditor() {
  $("edSaveBtn").addEventListener("click", saveFromEditor);
  $("edClearBtn").addEventListener("click", () => {
    editingId = null;
    fillEditor(null);
    setStatus("已清空编辑器", "");
  });
  $("edCopyBtn").addEventListener("click", async () => {
    const text = editorMarkdown();
    if (!text) return setStatus("正文还是空的", "err");
    try {
      await navigator.clipboard.writeText(text);
      setStatus("SKILL.md 已复制到剪贴板", "ok");
    } catch (_) {
      setStatus("复制失败，请手动全选复制", "err");
    }
  });
  $("edDownloadBtn").addEventListener("click", () => {
    const id = $("edId").value.trim() || "skill";
    downloadText(id + "-SKILL.md", editorMarkdown());
  });
  $("edPublishHelpBtn").addEventListener("click", publishHelp);
  $("edBody").addEventListener("input", renderEditorPreview);
  ["edId", "edTitle", "edDesc", "edVersion"].forEach((id) => $(id).addEventListener("input", renderEditorPreview));
  renderEditorPreview();
}

function editorMeta() {
  return {
    name: $("edId").value.trim(),
    title: $("edTitle").value.trim(),
    description: $("edDesc").value.trim(),
    version: $("edVersion").value.trim() || "1.0.0",
    author: $("edAuthor").value.trim(),
    tags: $("edTags")
      .value.split(/[,，]/)
      .map((x) => x.trim())
      .filter(Boolean),
    icon: $("edIcon").value.trim(),
  };
}

function editorMarkdown() {
  const meta = editorMeta();
  const body = $("edBody").value;
  if (!body.trim()) return "";
  const cleaned = {};
  for (const [k, v] of Object.entries(meta)) {
    if (Array.isArray(v) ? v.length : v) cleaned[k] = v;
  }
  return stringifySkillMd(cleaned, body);
}

function renderEditorPreview() {
  const md = editorMarkdown();
  $("edPreview").innerHTML = md
    ? renderMarkdown(md.replace(/^---[\s\S]*?---\r?\n?/, ""))
    : '<p class="muted">（左边写点什么，这里就会显示效果）</p>';
  const meta = editorMeta();
  const missing = [];
  if (!meta.name) missing.push("技能 id");
  if (!meta.title) missing.push("显示名");
  if (!meta.description) missing.push("一句话说明");
  if (!$("edBody").value.trim()) missing.push("正文");
  $("edStats").textContent = `${$("edBody").value.length} 字符 / ${md.split(/\r?\n/).length} 行`;
  $("edHint").textContent = missing.length
    ? "还需要填：" + missing.join("、")
    : editingId
      ? `正在编辑：${editingId}（保存后侧栏立刻可用）`
      : "可以直接保存为一份新技能";
}

function fillEditor(skill) {
  $("edId").value = skill ? skill.id : "";
  $("edTitle").value = skill ? skill.title || "" : "";
  $("edDesc").value = skill ? skill.description || "" : "";
  $("edVersion").value = skill ? skill.version || "1.0.0" : "1.0.0";
  $("edAuthor").value = skill ? skill.author || "" : "";
  $("edTags").value = skill && skill.tags ? skill.tags.join(", ") : "";
  $("edIcon").value = skill ? skill.icon || "" : "";
  $("edBody").value = skill
    ? skill.body || ""
    : `## 什么时候用\n\n（什么情况下该用这个技能）\n\n## 步骤\n\n1. 先…\n2. 再…\n\n## 注意\n\n- 涉及付款/提交/同意条款的动作必须先问我。\n`;
  renderEditorPreview();
}

function loadIntoEditor(id) {
  const s = skills[id];
  if (!s) return;
  editingId = id;
  fillEditor(s);
  $("edId").focus();
  setStatus("已载入编辑器：" + (s.title || s.id), "");
}

function startNewSkill() {
  editingId = null;
  fillEditor(null);
  $("edId").focus();
  setStatus("在下面写一份新技能", "");
}

async function saveFromEditor() {
  const meta = editorMeta();
  const body = $("edBody").value.trim();
  if (!meta.name) return setStatus("请填写技能 id", "err");
  if (!/^[a-z0-9][a-z0-9-]*$/.test(meta.name)) {
    return setStatus("技能 id 只能用小写字母、数字和连字符（例如 my-skill）", "err");
  }
  if (!meta.title) return setStatus("请填写显示名", "err");
  if (!body) return setStatus("正文不能为空", "err");

  const prev = skills[meta.name] || {};
  const isNew = !skills[meta.name];
  await upsertSkill({
    id: meta.name,
    ...meta,
    body,
    source: prev.source || "local",
    enabled: prev.enabled !== false,
    marketSource: prev.marketSource,
    marketVersion: prev.marketVersion,
    marketUrl: prev.marketUrl,
  });
  if (editingId && editingId !== meta.name) {
    // 改了 id：等同"另存为"，旧的删掉（避免留下一个同名的空壳）
    await deleteSkill(editingId);
    setStatus(`已另存为「${meta.title}」（原技能已删除）`, "ok");
  } else {
    setStatus(isNew ? `已保存新技能「${meta.title}」` : `已保存「${meta.title}」`, "ok");
  }
  editingId = meta.name;
  skills = await loadSkills();
  renderMine();
  renderMarket();
  renderEditorPreview();
}

async function publishHelp() {
  const id = $("edId").value.trim();
  if (!id) return setStatus("先填技能 id 再提交", "err");
  try {
    await navigator.clipboard.writeText(editorMarkdown());
  } catch (_) {}
  chrome.tabs.create({ url: `${DEFAULT_MARKET_REPO}/new/main/market/skills` });
  setStatus(`已复制内容。在 GitHub 新建 market/skills/${id}/SKILL.md，粘贴后提交 PR 即可。`, "ok");
}

// ---------- 预览弹层 ----------
function showPreviewDialog(skill) {
  const back = el("div", "modal-back");
  const box = el("div", "modal");
  const head = el("div", "modal-head");
  head.appendChild(el("span", "card-icon", skill.icon || "🧩"));
  head.appendChild(el("h2", null, skill.title || skill.id));
  head.appendChild(el("span", "card-ver", "v" + (skill.version || "?")));
  const close = el("button", "tiny", "关闭");
  close.addEventListener("click", () => back.remove());
  head.appendChild(close);
  box.appendChild(head);
  if (skill.description) box.appendChild(el("p", "card-desc", skill.description));
  const md = el("div", "md preview-scroll");
  md.innerHTML = renderMarkdown(skill.body || "");
  box.appendChild(md);

  const foot = el("div", "modal-foot");
  const copy = el("button", "tiny", "复制 SKILL.md");
  copy.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(skillMarkdown(skill));
      setStatus("已复制 SKILL.md", "ok");
    } catch (_) {}
  });
  foot.appendChild(copy);
  const dl = el("button", "tiny", "下载 .md");
  dl.addEventListener("click", () => downloadSkill(skill));
  foot.appendChild(dl);
  const use = el("button", "primary tiny", "复制「发给 AI 的指令」");
  use.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(buildSkillPrompt(skill));
      setStatus("已复制。回到页面粘进侧栏输入框即可", "ok");
      back.remove();
    } catch (_) {}
  });
  foot.appendChild(use);
  box.appendChild(foot);

  back.appendChild(box);
  back.addEventListener("click", (e) => {
    if (e.target === back) back.remove();
  });
  document.body.appendChild(back);
}

// ---------- 更新日志 ----------
let changelogLoaded = false;
async function loadChangelog() {
  if (changelogLoaded) return;
  const box = $("changelogBox");
  const vt = await loadLocalVersionTxt();
  if (!vt) {
    box.innerHTML = '<p class="muted">读不到本机的 version.txt。</p>';
    return;
  }
  const parts = [];
  for (const e of vt.entries || []) {
    parts.push(`### ${e.version}`);
    for (const line of e.lines || []) parts.push(line);
  }
  box.innerHTML = renderMarkdown(parts.join("\n"));
  changelogLoaded = true;
}

// ---------- 下载 ----------
function downloadText(filename, text) {
  const blob = new Blob([text], { type: "text/markdown;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

function skillMarkdown(skill) {
  return stringifySkillMd(
    {
      name: skill.id,
      title: skill.title,
      description: skill.description,
      version: skill.version,
      author: skill.author,
      tags: skill.tags,
      icon: skill.icon,
    },
    skill.body || ""
  );
}

function downloadSkill(skill) {
  downloadText(`${skill.id}-SKILL.md`, skillMarkdown(skill));
  setStatus(`已下载 ${skill.id}-SKILL.md`, "ok");
}

// ---------- 启动 ----------
(async function initMarket() {
  bindNav();
  bindMarket();
  bindMine();
  bindEditor();

  skills = await loadSkills();
  const ms = await loadMarketSettings();
  marketSource = ms.source || DEFAULT_MARKET_REPO;
  $("sourceInput").value = marketSource;
  $("marketMeta").textContent = ms.lastSyncAt
    ? `上次同步：${fmtTime(ms.lastSyncAt)}（${ms.lastCount || 0} 个技能）`
    : "尚未同步，点「获取技能」从仓库拉取";
  renderMine();
  renderMarket();

  // 直接进入技能页（#skills）或已经在技能页时，自动拉一次
  if ((location.hash || "").replace("#", "") === "skills") {
    loadChangelog();
    fetchMarket({ silent: true });
  }
})();

// 侧栏改了技能（比如用了某个技能后停用）→ 本页跟着刷新
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || !changes.ai_skills) return;
  loadSkills().then((s) => {
    skills = s;
    renderMine();
    renderMarket();
  });
});