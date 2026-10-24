import {
  getSettings,
  saveSettings,
  maskKey,
  uid,
} from "../lib/storage.js";
import { testKey, probeDomains, sanitizeKey, AGNES_DOMAINS } from "../lib/api.js";

const providerListEl = document.getElementById("providerList");
const addProviderBtn = document.getElementById("addProviderBtn");
const defaultProviderEl = document.getElementById("defaultProvider");
const defaultModelEl = document.getElementById("defaultModel");
const contextEnabledEl = document.getElementById("contextEnabled");
const contextWindowEl = document.getElementById("contextWindow");
const autoCompressAtEl = document.getElementById("autoCompressAt");
const saveBtn = document.getElementById("saveBtn");
const saveStatusEl = document.getElementById("saveStatus");

let settings = null;

init();

async function init() {
  settings = await getSettings();
  // 版本标记：一眼看出"现在跑的是不是最新构建"
  try {
    const badge = document.getElementById("verBadge");
    if (badge) badge.textContent = "v" + chrome.runtime.getManifest().version;
  } catch (_) {}
  render();
  addProviderBtn.addEventListener("click", addProvider);
  saveBtn.addEventListener("click", save);
  defaultProviderEl.addEventListener("change", renderDefaultModels);
}

function render() {
  providerListEl.innerHTML = "";
  settings.providers.forEach((p, idx) => providerListEl.appendChild(providerCard(p, idx)));
  renderDefaultSelectors();
  contextEnabledEl.checked = settings.contextEnabled !== false;
  if (contextWindowEl) contextWindowEl.value = String(settings.contextWindow || 128000);
  if (autoCompressAtEl) autoCompressAtEl.value = String(Math.round((settings.autoCompressAt || 0.9) * 100));
}

function providerCard(p, idx) {
  const card = document.createElement("div");
  card.className = "provider-card";

  const head = document.createElement("div");
  head.className = "card-head";
  const title = document.createElement("div");
  title.className = "card-title";
  title.textContent = p.name || "未命名供应商";
  head.appendChild(title);

  const delBtn = document.createElement("button");
  delBtn.className = "danger tiny";
  delBtn.textContent = "删除供应商";
  delBtn.addEventListener("click", () => {
    if (confirm(`确定删除供应商「${p.name}」及其全部 Key？`)) {
      settings.providers.splice(idx, 1);
      render();
    }
  });
  head.appendChild(delBtn);
  card.appendChild(head);

  // 基本信息
  const row1 = document.createElement("div");
  row1.className = "row";
  row1.appendChild(textField("名称", p.name, (v) => (p.name = v)));
  row1.appendChild(textField("Base URL", p.baseUrl, (v) => (p.baseUrl = v)));
  card.appendChild(row1);

  // 域名探测（主要服务 Agnes 这类多站点 Key 体系）
  const probeRow = document.createElement("div");
  probeRow.className = "row";
  const probeBtn = document.createElement("button");
  probeBtn.className = "tiny";
  probeBtn.textContent = "探测域名";
  probeBtn.title = "用第一个已启用的 Key 依次测试候选接入域名，自动匹配";
  const probeStatus = document.createElement("span");
  probeStatus.className = "hint";
  probeBtn.addEventListener("click", async () => {
    const key = (p.keys || []).find((k) => k.enabled !== false && sanitizeKey(k.value));
    if (!key) {
      probeStatus.textContent = "请先添加并启用至少一个 API Key";
      return;
    }
    probeBtn.disabled = true;
    probeStatus.textContent = "探测中…";
    try {
      const domains = Array.from(
        new Set([p.baseUrl, ...AGNES_DOMAINS].filter(Boolean))
      );
      const { matched, results } = await probeDomains(key, domains);
      if (matched) {
        p.baseUrl = matched;
        render();
        probeStatus.textContent = "已匹配：" + matched + "（记得保存）";
      } else {
        probeStatus.textContent =
          "所有候选域名均拒绝该 Key：" +
          results.map((r) => `${r.base} → ${r.status || "网络错误"}`).join("；") +
          "。请确认 Key 属于哪个站点（国际站 .com / 国内站 .cn）或重新生成 Key";
      }
    } catch (err) {
      probeStatus.textContent = "探测失败：" + (err.message || err);
    } finally {
      probeBtn.disabled = false;
    }
  });
  probeRow.appendChild(probeBtn);
  probeRow.appendChild(probeStatus);
  card.appendChild(probeRow);

  // 模型列表：每个模型一行，**各自设置上下文上限与回复上限**
  //（不同模型的上限本来就不一样，之前是一个全局值，不够用）
  const modelLabel = document.createElement("div");
  modelLabel.className = "block-label";
  modelLabel.textContent = "模型（每个模型可单独设置上限；留空则用下面「默认选项」里的默认值）";
  card.appendChild(modelLabel);

  const modelTable = document.createElement("div");
  modelTable.className = "model-table";
  const modelHead = document.createElement("div");
  modelHead.className = "model-row model-head";
  for (const t of ["模型 ID", "显示名", "图片", "上下文上限", "回复上限", ""]) {
    const c = document.createElement("span");
    c.textContent = t;
    modelHead.appendChild(c);
  }
  modelTable.appendChild(modelHead);

  (p.models || []).forEach((m, mIdx) => {
    modelTable.appendChild(modelRow(p, m, mIdx));
  });
  card.appendChild(modelTable);

  const addModelBtn = document.createElement("button");
  addModelBtn.className = "tiny";
  addModelBtn.textContent = "+ 添加模型";
  addModelBtn.addEventListener("click", () => {
    if (!p.models) p.models = [];
    p.models.push({ id: "", label: "", vision: false, contextWindow: null, maxTokens: null });
    render();
  });
  card.appendChild(addModelBtn);

  const modelHint = document.createElement("p");
  modelHint.className = "hint";
  modelHint.innerHTML =
    "上下文上限：这个模型一次能装多少 token（到达你设置的阈值时会自动压缩历史）。" +
    "回复上限：单次回复最多生成多少 token。<br/>" +
    "常见值：128000 / 4096（长上下文模型），32768 / 2048（小模型）；不确定就先留空。";
  card.appendChild(modelHint);

  // API Keys
  const keyLabel = document.createElement("div");
  keyLabel.className = "block-label";
  keyLabel.textContent = "API Key（可添加多个，自动轮换）";
  card.appendChild(keyLabel);

  const keyWrap = document.createElement("div");
  (p.keys || []).forEach((k, kIdx) => {
    keyWrap.appendChild(keyRow(p, k, kIdx));
  });
  card.appendChild(keyWrap);

  const addKeyBtn = document.createElement("button");
  addKeyBtn.className = "tiny";
  addKeyBtn.textContent = "+ 添加 Key";
  addKeyBtn.addEventListener("click", () => {
    if (!p.keys) p.keys = [];
    p.keys.push({ id: uid(), label: "Key " + (p.keys.length + 1), value: "", enabled: true });
    render();
  });
  card.appendChild(addKeyBtn);

  return card;
}

// 一个模型的编辑行：ID / 显示名 / 图片 / 上下文上限 / 回复上限 / 删除
function modelRow(provider, model, mIdx) {
  const row = document.createElement("div");
  row.className = "model-row";

  const idInput = document.createElement("input");
  idInput.type = "text";
  idInput.value = model.id || "";
  idInput.placeholder = "模型 ID";
  idInput.addEventListener("change", () => {
    model.id = idInput.value.trim();
    renderDefaultSelectors();
  });

  const labelInput = document.createElement("input");
  labelInput.type = "text";
  labelInput.value = model.label || "";
  labelInput.placeholder = "显示名（可留空）";
  labelInput.addEventListener("change", () => {
    model.label = labelInput.value.trim();
    renderDefaultSelectors();
  });

  const visionWrap = document.createElement("label");
  visionWrap.className = "model-vision";
  visionWrap.title = "勾选表示这个模型支持图片理解（可附截图）";
  const visionInput = document.createElement("input");
  visionInput.type = "checkbox";
  visionInput.checked = !!model.vision;
  visionInput.addEventListener("change", () => (model.vision = visionInput.checked));
  visionWrap.appendChild(visionInput);

  const mkNum = (value, placeholder, title, apply) => {
    const inp = document.createElement("input");
    inp.type = "number";
    inp.min = "0";
    inp.step = "1000";
    inp.value = value ? String(value) : "";
    inp.placeholder = placeholder;
    inp.title = title;
    inp.addEventListener("change", () => {
      const n = Number(inp.value);
      apply(Number.isFinite(n) && n > 0 ? Math.round(n) : null);
    });
    return inp;
  };

  const ctxInput = mkNum(
    model.contextWindow,
    "128000",
    "这个模型的上下文上限（token）。留空用默认值。",
    (v) => (model.contextWindow = v)
  );
  const maxInput = mkNum(
    model.maxTokens,
    "4096",
    "单次回复最多生成多少 token。留空用默认值。",
    (v) => (model.maxTokens = v)
  );

  const del = document.createElement("button");
  del.className = "tiny danger";
  del.textContent = "×";
  del.title = "删除这个模型";
  del.addEventListener("click", () => {
    provider.models.splice(mIdx, 1);
    render();
  });

  for (const el of [idInput, labelInput, visionWrap, ctxInput, maxInput, del]) row.appendChild(el);
  return row;
}

function keyRow(provider, key, kIdx) {
  const row = document.createElement("div");
  row.className = "key-row";

  const labelInput = document.createElement("input");
  labelInput.type = "text";
  labelInput.value = key.label || "";
  labelInput.placeholder = "备注，如：主 Key";
  labelInput.style.flex = "0 0 110px";
  labelInput.addEventListener("change", () => (key.label = labelInput.value));
  row.appendChild(labelInput);

  const keyInput = document.createElement("input");
  keyInput.type = "password";
  keyInput.value = key.value || "";
  keyInput.placeholder = key.value ? maskKey(key.value) : "sk-...";
  keyInput.addEventListener("change", () => {
    key.value = sanitizeKey(keyInput.value);
    keyInput.value = key.value;
  });
  row.appendChild(keyInput);

  const toggleView = document.createElement("button");
  toggleView.className = "tiny";
  toggleView.textContent = "显示";
  toggleView.addEventListener("click", () => {
    const showing = keyInput.type === "text";
    keyInput.type = showing ? "password" : "text";
    toggleView.textContent = showing ? "显示" : "隐藏";
  });
  row.appendChild(toggleView);

  const enableCheck = document.createElement("input");
  enableCheck.type = "checkbox";
  enableCheck.checked = key.enabled !== false;
  enableCheck.title = "启用此 Key";
  enableCheck.addEventListener("change", () => (key.enabled = enableCheck.checked));
  row.appendChild(enableCheck);

  const statusEl = document.createElement("span");
  statusEl.className = "key-status";
  statusEl.textContent = "";

  const testBtn = document.createElement("button");
  testBtn.className = "tiny";
  testBtn.textContent = "测试";
  testBtn.addEventListener("click", async () => {
    statusEl.textContent = "…";
    statusEl.className = "key-status";
    try {
      await testKey(provider, key, provider.models?.[0]?.id);
      statusEl.textContent = "可用";
      statusEl.className = "key-status ok";
    } catch (err) {
      statusEl.textContent = "失败";
      statusEl.className = "key-status fail";
      statusEl.title = err.message || String(err);
    }
  });
  row.appendChild(testBtn);
  row.appendChild(statusEl);

  const delBtn = document.createElement("button");
  delBtn.className = "danger tiny";
  delBtn.textContent = "移除";
  delBtn.addEventListener("click", () => {
    provider.keys.splice(kIdx, 1);
    render();
  });
  row.appendChild(delBtn);

  return row;
}

function textField(label, value, onChange) {
  const wrap = document.createElement("label");
  wrap.className = "field";
  const span = document.createElement("span");
  span.textContent = label;
  const input = document.createElement("input");
  input.type = "text";
  input.value = value || "";
  input.addEventListener("change", () => onChange(input.value));
  wrap.appendChild(span);
  wrap.appendChild(input);
  return wrap;
}

function addProvider() {
  settings.providers.push({
    id: uid(),
    name: "新供应商",
    baseUrl: "https://api.example.com/v1",
    models: [{ id: "model-id", label: "model-id" }],
    keys: [],
  });
  render();
}

function renderDefaultSelectors() {
  const currentP = settings.activeProviderId;
  const currentM = settings.activeModelId;

  defaultProviderEl.innerHTML = "";
  for (const p of settings.providers) {
    const opt = document.createElement("option");
    opt.value = p.id;
    opt.textContent = p.name;
    if (p.id === currentP) opt.selected = true;
    defaultProviderEl.appendChild(opt);
  }
  renderDefaultModels();

  if (currentM) defaultModelEl.value = currentM;
}

function renderDefaultModels() {
  const p = settings.providers.find((x) => x.id === defaultProviderEl.value);
  defaultModelEl.innerHTML = "";
  if (!p) return;
  for (const m of p.models || []) {
    const opt = document.createElement("option");
    opt.value = m.id;
    opt.textContent = m.label || m.id;
    defaultModelEl.appendChild(opt);
  }
}

async function save() {
  try {
    if (!settings.providers.length) {
      throw new Error("至少需要一个供应商");
    }
    for (const p of settings.providers) {
      if (!p.baseUrl || !/^https?:\/\//.test(p.baseUrl)) {
        throw new Error(`供应商「${p.name}」的 Base URL 无效`);
      }
    }
    settings.activeProviderId = defaultProviderEl.value;
    settings.activeModelId = defaultModelEl.value;
    settings.contextEnabled = contextEnabledEl.checked;
    if (contextWindowEl) {
      const v = Number(contextWindowEl.value);
      settings.contextWindow = Number.isFinite(v) && v >= 1000 ? Math.round(v) : 128000;
    }
    if (autoCompressAtEl) {
      const p = Number(autoCompressAtEl.value);
      settings.autoCompressAt =
        Number.isFinite(p) && p >= 50 && p <= 98 ? Math.round(p) / 100 : 0.9;
    }
    for (const p of settings.providers) {
      for (const k of p.keys || []) {
        k.value = sanitizeKey(k.value);
      }
    }
    await saveSettings(settings);
    saveStatusEl.textContent = "已保存 ✓";
    saveStatusEl.className = "save-status";
    setTimeout(() => (saveStatusEl.textContent = ""), 2500);
  } catch (err) {
    saveStatusEl.textContent = "保存失败：" + (err.message || err);
    saveStatusEl.className = "save-status err";
  }
}
