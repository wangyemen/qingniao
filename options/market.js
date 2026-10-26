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
  // 新格式：元数据放在 HTML 注释里（导出/复制用），导入时两种格式都认
  stringifySkillDoc,
  stripSkillMeta,
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

// ===== 两个市场（并列，共用同一套展示框架）=====
//   official = 官方市场（GitHub，我维护）        user = 用户市场（官网接口，社区投稿）
const USER_MARKET_DEFAULT = "https://qingniao.gt.tc/api/market.php";
const PAGE_SIZE = 12;
let marketTab = "official";                       // 当前这一栏
const marketState = { official: null, user: null }; // 各自的目录（切换时共用下面那套渲染）
const marketPage = { official: 1, user: 1 };
// market 变量本身在原文件上方已声明 = 当前这一栏的目录（沿用旧命名，改动最小）

const currentMarket = () => marketState[marketTab];
const currentSource = () => {
  if (marketTab === "user") return ($("userSourceInput").value || "").trim() || USER_MARKET_DEFAULT;
  return ($("sourceInput").value || "").trim() || DEFAULT_MARKET_REPO;
};
const isUserMarket = () => marketTab === "user";
const pageOf = () => marketPage[marketTab] || 1;
const setPage = (n) => (marketPage[marketTab] = Math.max(1, n));
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
    if (isUserMarket()) $("userSourceInput").value = USER_MARKET_DEFAULT;
    else $("sourceInput").value = DEFAULT_MARKET_REPO;
    fetchMarket({});
  });
  $("marketSearch").addEventListener("input", () => {
    setPage(1);
    renderMarket();
  });

  // 两个市场**并列**：切换只换数据源，展示框架（列表/搜索/分页）是同一套
  const switchTab = (tab) => {
    if (tab !== "official" && tab !== "user") return;
    marketTab = tab;
    market = currentMarket();
    $("tabOfficial").classList.toggle("active", tab === "official");
    $("tabUser").classList.toggle("active", tab === "user");
    $("officialSourceField").classList.toggle("hidden", tab !== "official");
    $("userSourceField").classList.toggle("hidden", tab !== "user");
    $("userMarketNote").classList.toggle("hidden", tab !== "user");
    $("marketSearch").value = "";
    setPage(1);
    syncMarketMeta();
    renderMarket();
    // 这一栏还没拉过 → 自动拉一次（静默，不打扰）
    if (!currentMarket()) fetchMarket({ silent: true });
  };
  $("tabOfficial").addEventListener("click", () => switchTab("official"));
  $("tabUser").addEventListener("click", () => switchTab("user"));
}

function syncMarketMeta() {
  const m = currentMarket();
  const label = isUserMarket() ? "用户市场" : "官方市场";
  if (m) {
    $("marketMeta").textContent = `${label}：已同步 ${m.count} 个技能 · 来源 ${m.label}`;
  } else {
    $("marketMeta").textContent = `${label}：尚未同步（点右上角「获取技能」）`;
  }
  // 两个按钮上顺便显示各自的数量，一眼看出哪边有新东西
  const n1 = marketState.official ? marketState.official.count : null;
  const n2 = marketState.user ? marketState.user.count : null;
  $("numOfficial").textContent = n1 == null ? "" : `(${n1})`;
  $("numUser").textContent = n2 == null ? "" : `(${n2})`;
}

async function fetchMarket({ silent } = {}) {
  const tab = marketTab;
  const input = currentSource();
  if (tab === "official") marketSource = input;
  if (!silent) {
    $("marketMeta").textContent = "正在获取…";
    setStatus("正在获取技能目录…");
  }
  try {
    const idx = await fetchMarketIndex(input);
    marketState[tab] = idx;
    if (tab === marketTab) market = idx;
    const patch =
      tab === "user"
        ? { userSource: input, userLastSyncAt: Date.now(), userLastCount: idx.count, userLastError: "" }
        : { source: input, repo: idx.repo, lastSyncAt: Date.now(), lastCount: idx.count, lastError: "" };
    await saveMarketSettings(patch);
    setPage(1);
    syncMarketMeta();
    renderMarket();
    if (!silent) setStatus(`获取成功：${idx.count} 个技能（${idx.label}）`, "ok");
  } catch (err) {
    marketState[tab] = null;
    if (tab === marketTab) market = null;
    const msg = String((err && err.message) || err);
    await saveMarketSettings(tab === "user" ? { userSource: input, userLastError: msg } : { source: input, lastError: msg });
    setPage(1);
    syncMarketMeta();
    renderMarket();
    if (!silent) setStatus("获取失败：" + msg, "err");
  }
}

function renderMarket() {
  const box = $("marketList");
  const pager = $("marketPager");
  box.innerHTML = "";
  market = currentMarket();
  if (pager) pager.innerHTML = "";
  if (!market) {
    if (pager) pager.classList.add("hidden");
    box.appendChild(
      el(
        "div",
        "empty",
        isUserMarket()
          ? "还没拉取用户市场。点右上角「获取技能」，或先确认官网接口地址对不对。"
          : "还没有技能列表。点右上角的「获取技能」从仓库拉取，或换一个来源地址。"
      )
    );
    return;
  }
  const q = $("marketSearch").value.trim().toLowerCase();
  const all = market.index.skills;
  const list = all.filter((s) => {
    if (!q) return true;
    return (
      s.id.toLowerCase().includes(q) ||
      s.title.toLowerCase().includes(q) ||
      s.description.toLowerCase().includes(q) ||
      s.tags.join(" ").toLowerCase().includes(q)
    );
  });
  if (!list.length) {
    if (pager) pager.classList.add("hidden");
    box.appendChild(el("div", "empty", q ? "没有匹配的技能。" : "这个市场里还没有技能。"));
    return;
  }

  // ---- 分页（两个市场共用这一套）----
  const pages = Math.max(1, Math.ceil(list.length / PAGE_SIZE));
  if (pageOf() > pages) setPage(pages);
  const page = pageOf();
  const from = (page - 1) * PAGE_SIZE;
  for (const m of list.slice(from, from + PAGE_SIZE)) box.appendChild(marketCard(m));

  if (pager) {
    pager.classList.remove("hidden");
    const mkBtn = (text, targetPage, disabled, active) => {
      const b = document.createElement("button");
      b.className = "mk-page" + (active ? " active" : "");
      b.textContent = text;
      b.disabled = !!disabled;
      b.addEventListener("click", () => {
        setPage(targetPage);
        renderMarket();
        $("marketList").scrollIntoView({ block: "nearest", behavior: "smooth" });
      });
      return b;
    };
    const info = document.createElement("span");
    info.className = "mk-page-info";
    info.textContent = `第 ${page} / ${pages} 页 · 共 ${list.length} 个`;
    pager.appendChild(mkBtn("‹ 上一页", page - 1, page <= 1, false));
    // 页码：当前页附近最多 7 个
    const start = Math.max(1, Math.min(page - 3, pages - 6));
    const end = Math.min(pages, start + 6);
    for (let i = start; i <= end; i++) pager.appendChild(mkBtn(String(i), i, false, i === page));
    pager.appendChild(mkBtn("下一页 ›", page + 1, page >= pages, false));
    pager.appendChild(info);
  }
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
  // 来源徽标：一眼分清"官方维护"和"社区投稿（未官方审核）"
  const fromUser = isUserMarket() || m.market === "user";
  meta.appendChild(el("span", "chip " + (fromUser ? "chip-user" : "chip-official"), fromUser ? "用户投稿 · 未审核" : "官方"));
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
    const fromUser = isUserMarket() || m.market === "user";
    const saved = await upsertSkill({
      ...skill,
      title: skill.title || m.title,
      description: skill.description || m.description,
      icon: skill.icon || m.icon,
      tags: skill.tags && skill.tags.length ? skill.tags : m.tags,
      source: "market",
      // ⚠️ 用户市场是社区投稿（审核过但不是官方出品）→ **装好默认停用**，
      //    让用户先看一眼正文、自己决定要不要打开（免得直接照着可疑指令去操作页面）。
      enabled: fromUser ? false : prev.enabled !== false,
      market: fromUser ? "user" : "official",
      marketAuthor: m.author || "",
      marketUrl: url,
      marketSource: marketSource || currentSource(),
      marketVersion: m.version,
    });
    skills = await loadSkills();
    renderMarket();
    renderMine();
    setStatus(
      fromUser
        ? `已安装「${saved.title}」v${saved.version}（用户投稿，**先停用**：到「我的技能」里看一遍正文再打开）`
        : `已安装「${saved.title}」v${saved.version}，回侧栏点「技能」即可用`,
      "ok"
    );
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
  const cleanup = $("cleanupMetaBtn");
  if (cleanup) cleanup.addEventListener("click", cleanupSkillMeta);
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

  // 投稿到用户市场（官网接口，免注册）
  const submit = el("button", "tiny", "投稿到用户市场");
  submit.title = "把这一个技能提交到官网的用户市场（会先进待审核队列）";
  submit.addEventListener("click", () => submitSkillToUserMarket(s, submit));
  actions.appendChild(submit);

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

// ---------- 投稿到用户市场（插件内提交）----------
// 把技能 POST 到官网的 submit.php（免注册，返回 editToken 供以后改/撤）。
// 提交成功只是进了**待审核队列** —— 审核通过才会出现在用户市场里。
async function submitSkillToUserMarket(s, btn) {
  const src = ($("userSourceInput").value || "").trim() || USER_MARKET_DEFAULT;
  const submitUrl = src.replace(/market\.php.*$/i, "submit.php");
  if (!/^https?:\/\//i.test(submitUrl)) return setStatus("用户市场地址不对，先在「用户市场」那一栏填好接口地址", "err");
  if (!confirm(
    `把「${s.title || s.id}」提交到用户市场？\n\n` +
    `会发到：${submitUrl}\n` +
    `提交后进入待审核队列；通过后会出现在用户市场（其他人能装）。\n` +
    `确认内容是原创、且不含违规或可能造成损失的操作吗？`
  )) return;

  if (btn) {
    btn.disabled = true;
    btn.textContent = "提交中…";
  }
  setStatus("正在提交到用户市场…");
  try {
    const payload = {
      slug: s.id,
      title: s.title || s.id,
      description: s.description || "",
      version: s.version || "1.0.0",
      author: s.author || "",
      tags: Array.isArray(s.tags) ? s.tags.join(",") : s.tags || "",
      icon: s.icon || "",
      body: stripSkillMeta(s.body || "").trim(),
      from: "plugin",
      agree: true,
    };
    const res = await fetch(submitUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const j = await res.json().catch(() => ({}));
    if (!j || !j.ok) throw new Error((j && j.error) || ("HTTP " + res.status));
    let tip = j.updated ? "已更新你之前投的那条，重新进入待审核" : "已提交，等待审核";
    if (j.editToken) {
      try {
        await navigator.clipboard.writeText(j.editToken);
        tip += "（editToken 已复制到剪贴板，请收好：凭它改/撤投稿）";
      } catch (_) {
        tip += "（editToken：" + j.editToken + " —— 请自己保存）";
      }
    }
    await upsertSkill({ id: s.id, marketSubmit: { at: Date.now(), status: j.status || "pending", url: submitUrl } });
    skills = await loadSkills();
    renderMine();
    setStatus("✅ " + tip, "ok");
  } catch (err) {
    setStatus("投稿失败：" + ((err && err.message) || err), "err");
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = "投稿到用户市场";
    }
  }
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
  // 编辑框里若被粘贴了一整份 SKILL.md（含元数据块），先剥掉 —— 元数据走表单字段
  const body = stripSkillMeta($("edBody").value);
  if (!body.trim()) return "";
  const cleaned = {};
  for (const [k, v] of Object.entries(meta)) {
    if (Array.isArray(v) ? v.length : v) cleaned[k] = v;
  }
  // 导出/复制用**新格式**（HTML 注释装元数据）：Markdown 渲染不显示，也不会被语法吃掉
  return stringifySkillDoc(cleaned, body);
}

function renderEditorPreview() {
  const md = editorMarkdown();
  // 新格式的元数据在 HTML 注释里，预览时再剥一次，保证不显示出来
  $("edPreview").innerHTML = md
    ? renderMarkdown(stripSkillMeta(md))
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

// 一键清理：把"正文里混进元数据块"的历史脏数据洗干净
// （以前用带 BOM 的文件导入时，整块 frontmatter 会被当成正文存下来）
async function cleanupSkillMeta() {
  skills = await loadSkills();
  const fixed = [];
  for (const s of Object.values(skills)) {
    const raw = String(s.body || "");
    const clean = stripSkillMeta(raw).trim();
    if (clean !== raw.trim()) {
      await upsertSkill({ ...s, body: clean });
      fixed.push(s.title || s.id);
    }
  }
  skills = await loadSkills();
  renderMine();
  renderEditorPreview();
  if (!fixed.length) return setStatus("没有需要清理的技能（正文都是干净的）", "");
  setStatus(`已清理 ${fixed.length} 个技能正文里的元数据残留：${fixed.join("、")}`, "ok");
}

async function saveFromEditor() {
  let meta = editorMeta();

  // 编辑框里可能被粘贴了一整份 SKILL.md（元数据块 + 正文）——
  // 保存前把元数据剥出来：**只把缺的字段补上**（不覆盖你已经填/改过的），正文只留正文。
  // 这样既不会把元数据存成正文，也不会出现"两份 frontmatter"越改越乱。
  const rawBody = $("edBody").value;
  const parsed = parseSkillMd(rawBody);
  if (parsed.form !== "none" && parsed.body.trim()) {
    const fill = (key, elId) => {
      const v = parsed.meta[key];
      const val = Array.isArray(v) ? v.join(", ") : v;
      if (val && !$(elId).value.trim()) {
        $(elId).value = String(val);
      }
    };
    fill("name", "edId");
    fill("title", "edTitle");
    fill("description", "edDesc");
    fill("version", "edVersion");
    fill("author", "edAuthor");
    fill("tags", "edTags");
    fill("icon", "edIcon");
    $("edBody").value = parsed.body; // 编辑框里也立刻变干净
    meta = editorMeta();
  }
  const body = stripSkillMeta($("edBody").value).trim();

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

// ---------- 导入技能（拖拽 / 选文件 / 粘贴内容）----------
//
// 格式就是导出时用的那一份：标准 SKILL.md（--- frontmatter --- + 正文）。
// 所以导入 = parseSkillMd 反过来解析，再 upsertSkill 存进来。
// 也兼容几种"顺手会拖进来"的东西：单个技能 JSON、市场目录 JSON（含 skills 数组）、
// 以及没有 frontmatter 的裸 Markdown（用文件名当 id、首行当标题）。

// 生成技能 id。⚠️ 只有"从文件名推出来的"才剥掉结尾的 -skill ——
// 导出文件名是 <id>-SKILL.md，所以要还原成 <id>；
// 但 frontmatter 里 model 自己写的 name（比如 "ai-skill"）不能被误剥。
function slugifyId(raw, opts) {
  const fromFilename = !!(opts && opts.fromFilename);
  let s = String(raw || "")
    .trim()
    .toLowerCase()
    .replace(/\.(md|markdown|txt|json)$/i, "");
  if (fromFilename) s = s.replace(/-skill$/i, "");
  return s.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

// 一个文件/一段文本 → 技能对象数组（解析失败抛错，错误信息给用户看）
function parseImportedSkill(text, filename) {
  const src = String(text || "");
  const trimmed = src.trim();
  if (!trimmed) throw new Error("文件是空的");

  // ① JSON：市场目录或单个技能
  if (/^[[{]/.test(trimmed) && /\.json$/i.test(filename || "")) {
    let data = null;
    try {
      data = JSON.parse(trimmed);
    } catch (_) {
      throw new Error("JSON 解析失败");
    }
    const list = Array.isArray(data) ? data : Array.isArray(data.skills) ? data.skills : [data];
    const out = [];
    for (const it of list) {
      if (!it || typeof it !== "object") continue;
      const id = slugifyId(it.id || it.name || it.title);
      if (!id) continue;
      const body = String(it.body || it.content || it.markdown || "").trim();
      if (!body) continue;
      out.push({
        id,
        title: String(it.title || it.id || id).trim(),
        description: String(it.description || "").trim(),
        version: String(it.version || "1.0.0").trim(),
        author: String(it.author || "").trim(),
        tags: Array.isArray(it.tags) ? it.tags.map(String) : [],
        icon: String(it.icon || "").trim(),
        body,
      });
    }
    if (!out.length) throw new Error("这份 JSON 里没有可导入的技能（需要 id + body）");
    return out;
  }

  // ② SKILL.md：新格式（HTML 注释装元数据）与老格式（--- frontmatter）都认；
//    两种都没有就用文件名兜底。正文一律再剥一次元数据（双保险，免得脏数据混进来）。
  const { meta, body } = parseSkillMd(src);
  const hasFm = !!(meta && (meta.name || meta.title));
  const mdBody = stripSkillMeta(String(body || "")).trim();
  if (!mdBody) throw new Error("没有正文内容");

  const id = slugifyId(meta.name || meta.title) || slugifyId(filename || "", { fromFilename: true });
  if (!id) throw new Error("看不出技能 id（frontmatter 里的 name，或文件名 <id>-SKILL.md）");
  const firstLine = (mdBody.split(/\r?\n/).find((l) => l.trim()) || "").replace(/^#+\s*/, "").trim();
  return [
    {
      id,
      title: String(meta.title || firstLine || id).trim(),
      description: String(meta.description || "").trim(),
      version: String(meta.version || "1.0.0").trim(),
      author: String(meta.author || "").trim(),
      tags: Array.isArray(meta.tags) ? meta.tags.map(String) : [],
      icon: String(meta.icon || "").trim(),
      // ⚠️ 这里必须是**剥掉元数据块之后的正文**（mdBody）。
      //    以前这里写的是 `text`（就是文件全文）—— 于是导入进来的技能正文里一直带着元数据块，
      //    在编辑框里能看见、再保存就变成两份元数据（用户报的就是这条，测试也抓到了）。
      body: mdBody,
      ...(hasFm ? {} : { note: "这份文件没有 frontmatter，标题/说明是从正文和文件名里推出来的" }),
    },
  ];
}

async function importSkillFiles(files) {
  const list = Array.from(files || []);
  if (!list.length) return;
  const parsed = [];
  const failed = [];
  for (const f of list) {
    // 只认文本类，别把图片拖进来还把页面卡住
    if (!/\.(md|markdown|txt|json)$/i.test(f.name || "")) {
      failed.push(`${f.name || "未命名文件"}：只支持 .md / .markdown / .txt / .json`);
      continue;
    }
    try {
      const text = await f.text();
      for (const s of parseImportedSkill(text, f.name)) parsed.push(s);
    } catch (err) {
      failed.push(`${f.name || "未命名文件"}：${(err && err.message) || err}`);
    }
  }
  if (!parsed.length) {
    setStatus("没有导入任何技能。" + failed.join("；"), "err");
    return;
  }

  // 同名处理：默认覆盖（多半是自己导出后又改过的版本）；用户不同意就保留为新副本
  skills = await loadSkills();
  const clashes = parsed.filter((s) => skills[s.id]);
  let overwrite = true;
  if (clashes.length) {
    const uniq = [...new Set(clashes.map((s) => s.id))];
    overwrite = window.confirm(
      `有 ${uniq.length} 个技能 id 已经存在：\n${uniq.join("、")}\n\n` +
        `点「确定」= 覆盖它们（保留原 id）\n点「取消」= 都保留成新副本（自动加后缀）`
    );
  }

  let added = 0;
  let replaced = 0;
  const renamed = [];
  for (const s of parsed) {
    let id = s.id;
    if (skills[id] && !overwrite) {
      let n = 2;
      while (skills[`${s.id}-${n}`]) n++;
      id = `${s.id}-${n}`;
      renamed.push(`${s.id} → ${id}`);
    }
    const prev = skills[id] || {};
    if (skills[id] && overwrite) replaced++;
    else added++;
    await upsertSkill({
      id,
      title: s.title || id,
      description: s.description || "",
      version: s.version || "1.0.0",
      author: s.author || "",
      tags: s.tags || [],
      icon: s.icon || "",
      body: s.body,
      // 导入进来的算"本地技能"；如果覆盖的是一个市场技能，保留它的市场来源信息
      source: prev.source || "local",
      enabled: prev.enabled !== false,
      marketSource: prev.marketSource,
      marketVersion: prev.marketVersion,
      marketUrl: prev.marketUrl,
      importedAt: Date.now(),
    });
  }

  skills = await loadSkills();
  renderMine();
  renderMarket();

  const parts = [`已导入 ${added} 个技能`];
  if (replaced) parts.push(`覆盖 ${replaced} 个同名`);
  if (renamed.length) parts.push(`重命名：${renamed.join("、")}`);
  if (failed.length) parts.push(`跳过 ${failed.length} 个（${failed.join("；")}）`);
  setStatus(parts.join(" · "), failed.length ? "err" : "ok");
}

function bindImport() {
  const drop = $("skillDrop");
  const input = $("skillFileInput");
  if (!drop || !input) return;

  $("importSkillBtn").addEventListener("click", () => input.click());
  input.addEventListener("change", async () => {
    await importSkillFiles(input.files);
    input.value = ""; // 同一个文件能再导入一次
  });

  // 点一下拖拽区也打开选文件（拖拽之外的手动路径）
  drop.addEventListener("click", () => input.click());
  drop.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      input.click();
    }
  });

  let depth = 0; // dragenter/dragleave 会冒泡，用计数避免闪
  const setOn = (on) => drop.classList.toggle("dragover", on);
  drop.addEventListener("dragenter", (e) => {
    e.preventDefault();
    depth++;
    setOn(true);
  });
  drop.addEventListener("dragover", (e) => {
    e.preventDefault(); // 不 preventDefault 浏览器就不允许放下
    e.dataTransfer.dropEffect = "copy";
    setOn(true);
  });
  drop.addEventListener("dragleave", (e) => {
    e.preventDefault();
    depth = Math.max(0, depth - 1);
    if (!depth) setOn(false);
  });
  drop.addEventListener("drop", async (e) => {
    e.preventDefault();
    depth = 0;
    setOn(false);
    const dt = e.dataTransfer;
    if (!dt) return;
    if (dt.files && dt.files.length) {
      await importSkillFiles(dt.files);
      return;
    }
    // 从别处拖来一段文字（比如从 GitHub 网页上拖选中的 SKILL.md 内容）
    const text = dt.getData ? dt.getData("text/plain") : "";
    if (text && text.trim()) {
      try {
        const parsed = parseImportedSkill(text, "拖入的文本.md");
        const file = new File([text], `${parsed[0].id}-SKILL.md`, { type: "text/markdown" });
        await importSkillFiles([file]);
      } catch (err) {
        setStatus("拖入的内容不是有效的 SKILL.md：" + ((err && err.message) || err), "err");
      }
      return;
    }
    setStatus("没读到文件；请拖入 .md 文件，或点这里选择文件", "err");
  });

  // 整页也能接住拖放（拖到面板外时给上面那块高亮，避免"拖了半天没反应"）
  window.addEventListener("dragover", (e) => {
    if (e.dataTransfer && Array.from(e.dataTransfer.types || []).includes("Files")) {
      e.preventDefault();
      setOn(true);
    }
  });
  window.addEventListener("dragleave", (e) => {
    if (e.relatedTarget == null) setOn(false);
  });
  window.addEventListener("drop", async (e) => {
    if (e.target && e.target.closest && e.target.closest("#skillDrop")) return; // 交给上面那块处理
    const dt = e.dataTransfer;
    if (!dt || !dt.files || !dt.files.length) return;
    e.preventDefault();
    setOn(false);
    await importSkillFiles(dt.files);
  });
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
  // 导出用**新格式**：元数据在 HTML 注释里 —— 打开看是正常的 Markdown（注释不显示），
  // 导入时又能把这几个字段自动填回表单
  return stringifySkillDoc(
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
  bindImport();
  bindEditor();

  skills = await loadSkills();
  const ms = await loadMarketSettings();
  marketSource = ms.source || DEFAULT_MARKET_REPO;
  $("sourceInput").value = marketSource;
  $("userSourceInput").value = ms.userSource || USER_MARKET_DEFAULT;
  $("userMarketNote").classList.add("hidden"); // 默认在"官方市场"那一栏
  syncMarketMeta();
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