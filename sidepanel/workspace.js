// 工作区运行时：一个工作区 = 一份完全独立的对话 + 一套独立的页面控制。
//
// 为什么要独立：用户要求多个工作区"同时运行、互不干扰"，并且各自可以用不同的模型。
// Chrome 的侧边栏一个窗口只有一个文档实例，所以"独立"只能做成：
//   每个工作区自己一份 chat DOM（非激活时脱离文档、但依然在跑）+ 自己的会话/abort/状态。
//
// 隔离底线：一个工作区只能读/操作自己 tabIds 里的标签页，别的工作区的标签页一律拒绝。

import { findProvider } from "../lib/storage.js";
import { chatStream } from "../lib/api.js";
import {
  extractAction,
  actionLabel,
  actionDetail,
  formatElements,
  ACTION_PROTOCOL,
  stripActionFence,
} from "../lib/protocol.js";
import { renderMarkdown, markdownToPlainText } from "../lib/markdown.js";
import { downscaleImage } from "../lib/attach.js";

// 单轮操作循环：不设硬性步数上限（用户明确要求）——真实任务经常要十几步。
// 唯一兜底是防死循环：同一动作反复失败超过 MAX_STUCK_FAILS 次就收手，否则白烧 token。
const MAX_STUCK_FAILS = 6;

const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));

// 可被"停止"打断的等待：用户点停止后要立刻结束，不能干等完 9 秒
function sleepAbortable(ms, signal) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      if (signal) signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      const e = new Error("aborted");
      e.name = "AbortError";
      reject(e);
    };
    if (signal) {
      if (signal.aborted) return onAbort();
      signal.addEventListener("abort", onAbort, { once: true });
    }
  });
}

// AI 报错自动重试：最多 5 次，等待 5s、6s、7s、8s、9s（逐次 +1 秒，用户要求）。
// 明显的"重试也没用"的错误不重试：配置/鉴权/请求格式/找不到（400/401/403/404）。
export const MAX_AI_RETRIES = 5;

function isRetryable(err) {
  if (!err || err.name === "AbortError") return false;
  const s = Number(err.status) || 0;
  if ([400, 401, 403, 404].includes(s)) return false;
  return true;
}

// 换模型用的候选队列：从当前模型开始，把同一供应商的其它模型也排上，
// 这样"某个模型连续失败"时能自动换一个继续（用户要求：5 次还不行就换下一个模型）。
function buildModelQueue(provider, currentId) {
  const ids = (provider.models || []).map((m) => m && m.id).filter(Boolean);
  if (!ids.length) return currentId ? [currentId] : [];
  const i = ids.indexOf(currentId);
  const ordered = i >= 0 ? [...ids.slice(i), ...ids.slice(0, i)] : ids;
  return [...new Set(ordered)];
}

// 截图 2 秒冷却（全局共享：浏览器 captureVisibleTab 有限流）
let lastShotAt = 0;

// 由某个标签页打开的新标签页（target=_blank / window.open）——动作后要能接管它。
// 模块级共享：只有这一个侧栏文档，各工作区共用同一份"谁开了谁"的事实。
const openedFrom = [];
export function noteOpenedTab(t) {
  if (t && t.openerTabId != null) openedFrom.push({ id: t.id, openerId: t.openerTabId, at: Date.now() });
  while (openedFrom.length > 32) openedFrom.shift();
}

// ===== 记忆压缩：粗略 token 估算 + 压缩 =====
//
// 没有本地分词器，用经验估算：CJK / 全角字符按 1 token，其余按 1/4 token
//（英文约 4 字符 1 token）。宁可略微高估，早一点压缩比爆上下文好。
export function estimateTokens(text) {
  const s = String(text || "");
  let cjk = 0;
  for (const ch of s) {
    if (ch >= "\u2e80") cjk++; // CJK、全角标点、假名等
  }
  const other = s.length - cjk;
  return cjk + Math.ceil(other / 4);
}

// 估算一整组 messages 的 token（含附图，按每张固定成本计）
export function estimateMessages(messages) {
  let total = 0;
  for (const m of messages || []) {
    const c = m && m.content;
    if (typeof c === "string") total += estimateTokens(c);
    else if (Array.isArray(c)) {
      for (const part of c) {
        if (!part) continue;
        if (part.type === "text") total += estimateTokens(part.text);
        else if (part.type === "image_url") total += 900; // 低清图按 ~900 token 粗估
      }
    }
    total += 4; // 每条消息的固定开销
  }
  return total;
}

// ===== 标签页基础工具 =====

export async function describeTab(tabId) {
  try {
    const t = await chrome.tabs.get(tabId);
    return { id: t.id, url: t.url || "", title: t.title || "", windowId: t.windowId, active: !!t.active };
  } catch (_) {
    return null;
  }
}

async function pageUrlOf(tabId) {
  try {
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => location.href,
    });
    return typeof result === "string" ? result : null;
  } catch (_) {
    return null;
  }
}

// 动作前校验目标页：还在不在？还是不是同一个页面？
async function preflightTarget(tabId, expectUrl) {
  const expect = String(expectUrl || "");
  const tab = await describeTab(tabId);
  if (!tab) return { dead: true };
  if (!/^https?:/i.test(expect)) return { ok: true, tab };
  const liveUrl = await pageUrlOf(tabId);
  if (liveUrl == null) {
    const guess = tab.url || "";
    if (guess && /^https?:/i.test(guess) && guess !== expect) {
      return { changed: true, url: guess, title: tab.title || "", tab };
    }
    return { ok: true, tab };
  }
  if (liveUrl !== expect) return { changed: true, url: liveUrl, title: tab.title || "", tab };
  return { ok: true, tab };
}

async function injectScript(tabId, file) {
  await chrome.scripting.executeScript({ target: { tabId }, files: [file] });
}

async function waitTabSettle(tabId, maxMs = 6000) {
  const t0 = Date.now();
  let sawLoading = false;
  while (Date.now() - t0 < maxMs) {
    let t;
    try {
      t = await chrome.tabs.get(tabId);
    } catch (_) {
      return null;
    }
    if (!t) return null;
    if (t.status === "loading") {
      sawLoading = true;
      await sleepMs(250);
      continue;
    }
    if (t.status === "complete") {
      if (sawLoading) await sleepMs(350);
      return t;
    }
    await sleepMs(200);
  }
  try {
    return await chrome.tabs.get(tabId);
  } catch (_) {
    return null;
  }
}

async function getPageSnapshot(tabId) {
  const t = await waitTabSettle(tabId, 6000);
  if (t && !/^https?:/.test(t.url || "")) {
    return { restricted: true, url: t.url || "", title: t.title || "", elements: [] };
  }
  const delays = [0, 400, 800, 1200, 1600];
  for (const delay of delays) {
    if (delay) await sleepMs(delay);
    try {
      await injectScript(tabId, "content/control.js");
      const [{ result }] = await chrome.scripting.executeScript({
        target: { tabId },
        func: (max) => globalThis.__aiCtl.snapshot(max),
        args: [60],
      });
      if (result) {
        result.empty = !(result.elements && result.elements.length);
        return result;
      }
    } catch (_) {}
  }
  let url = "";
  let title = "";
  try {
    const cur = await chrome.tabs.get(tabId);
    url = cur?.url || "";
    title = cur?.title || "";
  } catch (_) {}
  const unreachable = /^https?:/.test(url);
  return { failed: true, empty: true, unreachable, url, title, elements: [] };
}

async function setBanner(tabId, show) {
  if (tabId == null) return;
  try {
    await injectScript(tabId, "content/control.js");
    await chrome.scripting.executeScript({
      target: { tabId },
      func: (s) => globalThis.__aiCtl.banner(s),
      args: [show],
    });
  } catch (_) {}
}

async function captureScreenshot(tab) {
  const now = Date.now();
  if (now - lastShotAt < 2000) {
    throw new Error("截图太频繁，请稍候再试（2 秒冷却）");
  }
  let windowId = null;
  if (tab && tab.windowId != null) {
    const live = await describeTab(tab.id != null ? tab.id : tab);
    if (live && !live.active) {
      throw new Error("目标页面不在前台，截图会拍到别的页面。请先切到该标签页");
    }
    windowId = live ? live.windowId : tab.windowId;
  }
  lastShotAt = now;
  const dataUrl = await chrome.tabs.captureVisibleTab(windowId, { format: "jpeg", quality: 72 });
  return await downscaleImage(dataUrl, 1280);
}

// ===== 省 token 的小工具 =====

function elementsSig(snapshot) {
  const els = snapshot?.elements || [];
  if (!snapshot || snapshot.restricted || snapshot.failed) return "none|" + (snapshot?.url || "");
  return (
    (snapshot.url || "") +
    "|" +
    els.map((e) => [e.i, e.tag, e.label, e.href || "", e.disabled ? "d" : ""].join(":")).join("~")
  );
}

function stripElementLists(text) {
  return String(text)
    .replace(/【(?:最新可交互元素|当前可交互元素)】\n[\s\S]*?(?=\n【|$)/g, "（元素列表已省略以节省上下文）\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// ===== 工作区运行时 =====

export class WorkspaceRuntime {
  /**
   * @param {object} opts
   * @param {object} opts.ws        工作区记录 { id, rootTabId, tabIds, sessionId, providerId, modelId }
   * @param {object} opts.session   会话对象（已带 workspaceId）
   * @param {object} opts.ctx       { getSettings(), getAliveTabs(ws), addTab(ws, tabId), onStateChange(rt), onDeferChange(rt) }
   */
  constructor({ ws, session, ctx }) {
    this.ws = ws;
    this.session = session;
    this.ctx = ctx;

    // 运行态（每个工作区一份，互不影响）
    this.busy = false;
    this.abortController = null;
    this.pendingConfirm = null;
    this.attachments = [];
    this.activeDeferTask = null;
    this.wakeQueue = [];
    this.targetPageLabel = "";
    this.status = { text: "", kind: "" };
    // 最近一次"执行动作"的时刻：用来判断新弹出的页是不是 AI 自己开的
    this.lastActionAt = 0;
    // "这份工作区正在别处运行"（Chrome 侧栏是每标签页一份文档实例，
    // 显示给你的那份可能不是正在跑的那份）→ 用来正确显示"停止"按钮
    this.remoteBusy = false;
    // 别的面板实例转过来的待发消息（本实例是执行者，忙完接着发）
    this.pendingSends = [];
    // 记忆压缩状态（compressing 防重入；compressedThisTurn 保证一轮只压一次）
    this.compressing = false;
    this.compressedThisTurn = false;

    // 每个工作区自己一份 chat DOM（非激活时脱离文档，但照样能跑）
    this.chatEl = document.createElement("div");
    this.chatEl.className = "chat";
    this.emptyHintEl = document.createElement("div");
    this.emptyHintEl.className = "empty-hint";
    this.emptyHintEl.innerHTML = `
      <div class="orb">
        <img src="../assets/icon128.png" alt="青鸟" />
      </div>
      <h3>青鸟</h3>
      <div class="ver-note"></div>
      <p class="sub">对着当前网页提问，或让我直接操作页面</p>
      <div class="suggestions">
        <button data-fill="总结一下当前页面的要点">总结当前页面</button>
        <button data-fill="帮我在这个页面上找到并填写表单">帮我填表</button>
        <button data-fill="这个页面讲了什么？有哪些关键信息？">页面要点</button>
        <button data-fill="帮我点击页面上的关键操作，并说明每一步">代我操作</button>
      </div>`;
    this.chatEl.appendChild(this.emptyHintEl);
    // 版本标记：方便确认"跑的是不是最新构建"
    try {
      const vn = this.emptyHintEl.querySelector(".ver-note");
      if (vn) vn.textContent = "v" + chrome.runtime.getManifest().version;
    } catch (_) {}
    // 快捷建议：只改输入框，不自动发送
    for (const b of this.emptyHintEl.querySelectorAll(".suggestions button")) {
      b.addEventListener("click", () => {
        this.ctx.fillInput(b.dataset.fill || b.textContent || "");
      });
    }
    this.syncEmptyHint();
  }

  // 这个工作区当前允许操作的标签页（活着的那几个）
  get tabIds() {
    return this.ws.tabIds || [];
  }

  owns(tabId) {
    return tabId != null && this.tabIds.includes(tabId);
  }

  // 取"某个标签页刚打开的子标签页"，但**不消费**记录。
  // 为什么不能消费：侧栏的 onCreated 需要立刻把子页并入工作区（否则中间一瞬间面板会
  // 切到空对话、打断正在跑的一轮）；随后动作循环里也要能知道"上一步开了新页"。
  // 两边都要读，所以这里只查不删 —— 记录靠时间窗失效。
  //
  // ⚠️ since 必须传"上一次动作的时刻"，不能用固定 15 秒：
  //    否则上一轮（甚至上一个工作区）打开的子页记录会在下一轮又被当成"刚刚开了新页"，
  //    把正常动作误判成"目标页已切换"拦下来（E2E S12 就踩了这个坑）。
  // 另外已经处理过的子页要记下来，避免同一条记录被反复触发。
  peekOpenedChild(parentId, since = 0) {
    const done = (this._handledChildren ||= new Set());
    for (let i = openedFrom.length - 1; i >= 0; i--) {
      const rec = openedFrom[i];
      if (rec.openerId !== parentId) continue;
      if (rec.at < since) continue;
      if (done.has(rec.id)) continue;
      return rec.id;
    }
    return null;
  }

  markChildHandled(tabId) {
    (this._handledChildren ||= new Set()).add(tabId);
  }

  addTab(tabId) {
    if (tabId == null) return false;
    if (this.ws.tabIds.includes(tabId)) return false;
    this.ws.tabIds.push(tabId);
    return true;
  }

  removeTab(tabId) {
    const i = this.ws.tabIds.indexOf(tabId);
    if (i < 0) return false;
    this.ws.tabIds.splice(i, 1);
    return true;
  }

  get alive() {
    return this.tabIds.length > 0;
  }

  // ===== 状态回显（只有激活的工作区才更新共享 UI）=====
  setStatus(text, kind) {
    this.status = { text: text || "", kind: kind || "" };
    this.ctx.onStateChange(this);
  }

  syncEmptyHint() {
    const has = this.session.messages.some((m) => !m.isActionResult);
    this.emptyHintEl.style.display = has ? "none" : "";
  }

  scrollChat() {
    this.chatEl.scrollTop = this.chatEl.scrollHeight;
  }

  // ===== 渲染 =====

  renderSession() {
    this.chatEl.querySelectorAll(".msg").forEach((el) => el.remove());
    for (const m of this.session.messages) {
      if (m.isActionResult) continue;
      if (m.role === "user") {
        this.createUserBubble(m.content, { attachNote: m.attachNote });
      } else if (m.role === "assistant") {
        const ui = this.createAssistantBubble();
        if (m.reasoning) ui.setThinking(m.reasoning, { streaming: false, open: false });
        if (Array.isArray(m.steps)) {
          for (const st of m.steps) {
            if (st.preText) ui.appendAnswer(st.preText);
            ui.addToolCard(st.action, st.result);
          }
        }
        ui.appendAnswer(m.finalText !== undefined ? m.finalText : m.content || "");
        ui.setMeta(m.meta || "");
      } else if (m.role === "error") {
        this.addErrorBubble(m.content);
      }
    }
    this.syncEmptyHint();
    this.scrollChat();
  }

  createUserBubble(text, opts = {}) {
    this.emptyHintEl.style.display = "none";
    const div = document.createElement("div");
    div.className = "msg user";
    div.textContent = text;
    if (opts.attachNote) {
      const note = document.createElement("span");
      note.className = "attach-note";
      note.textContent = opts.attachNote;
      div.appendChild(note);
    }
    this.chatEl.appendChild(div);
    this.scrollChat();
    return div;
  }

  addErrorBubble(text) {
    this.emptyHintEl.style.display = "none";
    const div = document.createElement("div");
    div.className = "msg error";
    div.textContent = text;
    this.chatEl.appendChild(div);
    this.scrollChat();
  }

  addNoteBubble(text) {
    this.emptyHintEl.style.display = "none";
    const div = document.createElement("div");
    div.className = "msg note";
    div.textContent = text;
    this.chatEl.appendChild(div);
    this.scrollChat();
    return div;
  }

  createAssistantBubble() {
    this.emptyHintEl.style.display = "none";
    const root = document.createElement("div");
    root.className = "msg assistant";

    const thinkingHost = document.createElement("div");
    const toolsEl = document.createElement("div");
    toolsEl.className = "seg seg-tools";
    const bodyEl = document.createElement("div");
    bodyEl.className = "seg body";
    const metaRow = document.createElement("div");
    metaRow.className = "meta-row";
    const metaEl = document.createElement("span");
    metaEl.className = "meta";
    const copyBtn = document.createElement("button");
    copyBtn.className = "msg-copy";
    copyBtn.type = "button";
    copyBtn.title = "复制为纯文本";
    copyBtn.innerHTML =
      '<svg viewBox="0 0 24 24"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h8"/></svg><span>复制</span>';
    metaRow.appendChild(metaEl);
    metaRow.appendChild(copyBtn);

    root.appendChild(thinkingHost);
    root.appendChild(toolsEl);
    root.appendChild(bodyEl);
    root.appendChild(metaRow);
    this.chatEl.appendChild(root);
    this.scrollChat();

    const rt = this;
    let thinking = null;
    let mdBuf = "";
    let mdTimer = 0;
    let mdPending = false;

    function paint(immediate) {
      const run = () => {
        mdPending = false;
        mdTimer = 0;
        bodyEl.innerHTML = renderMarkdown(mdBuf);
      };
      if (immediate) {
        if (mdTimer) clearTimeout(mdTimer);
        run();
        return;
      }
      if (mdPending) return;
      mdPending = true;
      mdTimer = setTimeout(run, 60);
    }

    function ensureThinking() {
      if (thinking) return thinking;
      const seg = document.createElement("div");
      seg.className = "seg seg-thinking open";
      seg.innerHTML = `
        <button class="seg-head" type="button">
          <svg class="ic-bulb" viewBox="0 0 24 24"><path d="M9 18h6M10 21h4M12 3a6 6 0 0 1 3.6 10.8c-.7.6-1.1 1.4-1.2 2.2h-4.8c-.1-.8-.5-1.6-1.2-2.2A6 6 0 0 1 12 3z"/></svg>
          <svg class="ic-spin spin" viewBox="0 0 24 24" style="display:none"><path d="M12 3a9 9 0 1 0 9 9" /></svg>
          <span class="seg-title">思考过程</span>
          <svg class="chev" viewBox="0 0 24 24"><path d="M6 9l6 6 6-6" /></svg>
        </button>
        <div class="seg-body"><div><pre class="seg-text"></pre></div></div>
      `;
      const head = seg.querySelector(".seg-head");
      const textEl = seg.querySelector(".seg-text");
      head.addEventListener("click", () => seg.classList.toggle("open"));
      thinkingHost.appendChild(seg);

      thinking = {
        seg,
        append(t) {
          textEl.textContent += t;
          const inner = textEl.parentElement;
          inner.scrollTop = inner.scrollHeight;
          textEl.scrollTop = textEl.scrollHeight;
        },
        setStreaming(on) {
          seg.querySelector(".ic-spin").style.display = on ? "" : "none";
          seg.querySelector(".ic-bulb").style.display = on ? "none" : "";
          if (!on) seg.classList.remove("open");
        },
        setOpen(on) {
          seg.classList.toggle("open", on);
        },
      };
      return thinking;
    }

    function appendAnswer(text) {
      if (!text) return;
      mdBuf += (mdBuf ? "\n" : "") + text;
      paint(true);
    }

    function addToolCard(action, result) {
      const card = document.createElement("div");
      card.className = "tool-card pending";
      card.innerHTML = `
        <div class="tool-head">
          <svg viewBox="0 0 24 24"><path d="M13 2L4 14h6l-1 8 9-12h-6l1-8z"/></svg>
          <span class="tool-title"></span>
        </div>
        <div class="tool-detail"></div>
        <div class="tool-result" hidden></div>
        <div class="tool-actions">
          <button class="ok-btn" type="button">执行</button>
          <button class="cancel-btn" type="button">取消</button>
        </div>
      `;
      card.querySelector(".tool-title").textContent = actionLabel(action);
      card.querySelector(".tool-detail").textContent = actionDetail(action);
      if (result === undefined && rt.targetPageLabel) {
        const pageEl = document.createElement("span");
        pageEl.className = "tool-page";
        pageEl.textContent = "页面：" + rt.targetPageLabel;
        card.querySelector(".tool-detail").appendChild(pageEl);
      }
      toolsEl.appendChild(card);
      rt.scrollChat();

      const handle = {
        root: card,
        setState(state, note) {
          card.classList.remove("pending", "running", "done", "failed", "cancelled");
          card.classList.add(state);
          const actions = card.querySelector(".tool-actions");
          const res = card.querySelector(".tool-result");
          if (state === "running") {
            if (actions) actions.innerHTML = "<span class='tool-detail'>执行中…</span>";
          } else if (state === "done" || state === "failed" || state === "cancelled") {
            if (actions) actions.remove();
            res.hidden = false;
            res.textContent = note || "";
          }
        },
        setResult(r) {
          if (!r) return;
          if (r.cancelled) return handle.setState("cancelled", "已取消：" + (r.msg || ""));
          if (r.skipped) return handle.setState("cancelled", "已跳过：" + (r.msg || "重复动作"));
          handle.setState(r.ok ? "done" : "failed", (r.ok ? "✓ " : "✗ ") + (r.msg || ""));
        },
      };
      if (result) handle.setResult(result);
      return handle;
    }

    copyBtn.addEventListener("click", async () => {
      const raw = stripActionFence(mdBuf || bodyEl.innerText || "");
      const text = markdownToPlainText(raw);
      const ok = await writeClipboard(text);
      copyBtn.classList.add(ok ? "copied" : "failed");
      copyBtn.querySelector("span").textContent = ok ? "已复制" : "复制失败";
      setTimeout(() => {
        copyBtn.classList.remove("copied", "failed");
        copyBtn.querySelector("span").textContent = "复制";
      }, 1600);
    });

    return {
      root,
      bodyEl,
      metaEl,
      toolsEl,
      ensureThinking,
      addToolCard,
      setThinking(text, opts = {}) {
        const t = ensureThinking();
        t.seg.querySelector(".seg-text").textContent = text || "";
        t.setStreaming(!!opts.streaming);
        if (opts.open !== undefined) t.setOpen(opts.open);
      },
      appendThinking(t) {
        ensureThinking().append(t);
      },
      finishThinking() {
        if (thinking) thinking.setStreaming(false);
      },
      collapseThinking() {
        if (thinking) thinking.setOpen(false);
      },
      setAnswer(text) {
        mdBuf = stripActionFence(text);
        paint(true);
      },
      appendAnswer,
      setStreamingAnswer(text) {
        mdBuf = stripActionFence(text);
        bodyEl.classList.add("stream-cursor");
        paint(false);
        rt.scrollChat();
      },
      endStreamingAnswer() {
        bodyEl.classList.remove("stream-cursor");
        paint(true);
      },
      setMeta(text) {
        metaEl.textContent = text || "";
      },
      remove() {
        root.remove();
      },
      scroll: () => rt.scrollChat(),
    };
  }

  // ===== 动作确认 =====
  confirmAction(card, autoMode, signal) {
    return new Promise((resolve) => {
      let settled = false;
      const finish = (v) => {
        if (settled) return;
        settled = true;
        this.pendingConfirm = null;
        signal?.removeEventListener("abort", onAbort);
        resolve(v);
      };
      const onAbort = () => finish(false);
      if (autoMode) {
        card.setState("running");
        finish(true);
        return;
      }
      signal?.addEventListener("abort", onAbort, { once: true });
      this.pendingConfirm = finish;
      card.root.querySelector(".ok-btn").addEventListener("click", () => {
        card.setState("running");
        finish(true);
      });
      card.root.querySelector(".cancel-btn").addEventListener("click", () => finish(false));
    });
  }

  // ===== 后台任务提示条 =====
  deferLabel(task) {
    if (!task || !task.until) return "等待条件满足";
    const u = task.until;
    return u.type === "video-ended"
      ? "等待视频播放结束"
      : u.type === "text-appear"
        ? `等待页面出现「${(u.text || "").slice(0, 16)}」`
        : u.type === "element-appear"
          ? `等待元素「${(u.text || "").slice(0, 16)}」出现`
          : u.type === "timeout"
            ? `定时等待（${u.seconds || 60} 秒）`
            : "等待条件满足";
  }

  showDeferChip() {
    this.ctx.onDeferChange(this);
  }

  hideDeferChip() {
    this.activeDeferTask = null;
    this.ctx.onDeferChange(this);
  }

  async cancelActiveDefer() {
    const id = this.activeDeferTask && this.activeDeferTask.id;
    if (!id) return;
    const task = this.activeDeferTask;
    this.activeDeferTask = null;
    this.ctx.onDeferChange(this);
    try {
      await chrome.runtime.sendMessage({ type: "defer:cancel", taskId: id });
    } catch (_) {}
    this.addNoteBubble("已取消后台任务：" + ((task.instruction || "").slice(0, 40) || "等待条件满足"));
    this.setStatus("已取消后台任务", "");
  }

  // ===== 读取页面上下文 =====
  async extractPageContext(tabId) {
    let id = tabId;
    if (id == null) id = this.ws.rootTabId;
    if (id == null || !this.owns(id)) return null;
    let tab = null;
    try {
      tab = await chrome.tabs.get(id);
    } catch (_) {
      return null;
    }
    if (!tab || !tab.url || !/^https?:/.test(tab.url)) return null;
    try {
      await injectScript(tab.id, "content/extract.js");
      const [{ result }] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: () => globalThis.__aiBrowseExtract(6000),
      });
      return result || null;
    } catch (_) {
      return null;
    }
  }

  // ===== 页面动作（带工作区隔离守卫）=====
  async runPageAction(tabId, action) {
    // 隔离守卫：只能操作本工作区的标签页。这是硬底线，绝不能落到别的工作区或用户自己的页面上。
    if (tabId != null && !this.owns(tabId)) {
      return {
        ok: false,
        msg: "目标标签页不在当前 AI 工作区内，已拒绝操作",
        hint:
          "你只能操作本工作区里的标签页，以及你自己打开的新标签页。" +
          "其它工作区的页面你看不到也不能操作。如需去新页面，用 navigate 打开它。",
      };
    }

    if (action && action.action === "screenshot") {
      try {
        const tab = await chrome.tabs.get(tabId);
        if (!tab.active) {
          return { ok: false, msg: "目标标签页不在前台，无法截图。请让用户切换到该标签页，或改用元素操作/extract" };
        }
        const dataUrl = await captureScreenshot(tab);
        return { ok: true, msg: "已截取当前页面截图", screenshot: dataUrl };
      } catch (err) {
        return { ok: false, msg: "截图失败：" + (err.message || err) };
      }
    }

    if (action && action.action === "switchtab") {
      const want = Number(action.target);
      const alive = await this.ctx.getAliveTabs(this);
      if (!alive.length) return { ok: false, msg: "AI 工作区里没有可切换的标签页" };
      const hit = alive.find((t) => t.id === want);
      if (!hit) {
        const names = alive.map((t, i) => `[${i}] ${(t.title || t.url || "未命名").slice(0, 30)}`).join("  ");
        return {
          ok: false,
          msg: `标签页 #${want} 不在当前 AI 工作区内，不能切换过去`,
          hint: `你只能切换到本工作区内的标签页：${names}`,
        };
      }
      try {
        await chrome.tabs.update(hit.id, { active: true });
        await chrome.windows.update(hit.windowId, { focused: true }).catch(() => {});
        return { ok: true, msg: `已切换到标签页「${(hit.title || hit.url || "未命名").slice(0, 30)}」` };
      } catch (err) {
        return { ok: false, msg: "切换标签页失败：" + (err.message || err) };
      }
    }

    if (action && action.action === "navigate") {
      const url = String(action.url || "").trim();
      if (!/^https?:\/\//i.test(url)) return { ok: false, msg: "仅支持 http(s) 网址" };
      try {
        await chrome.tabs.update(tabId, { url });
        const settled = await waitTabSettle(tabId, 8000);
        return {
          ok: true,
          msg: "已跳转到 " + (settled?.url || url),
          navigated: true,
          url: settled?.url || url,
          loading: settled?.status === "loading",
        };
      } catch (err) {
        return { ok: false, msg: "跳转失败：" + (err.message || err) };
      }
    }

    if (action && action.action === "defer") {
      const taskId = "d" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
      const instruction = String(action.instruction || "").trim();
      if (!instruction) {
        return {
          ok: false,
          msg: "defer 缺少 instruction（唤醒后要继续做什么）",
          hint: '请带上 instruction 字段，例如 {"action":"defer","until":{"type":"timeout","seconds":60},"instruction":"1分钟后刷新页面并总结"}',
        };
      }
      const until = action.until && typeof action.until === "object" ? action.until : { type: String(action.until || "timeout") };
      let armed = { ok: true, msg: "" };
      try {
        await injectScript(tabId, "content/control.js");
        const [{ result: r }] = await chrome.scripting.executeScript({
          target: { tabId },
          func: (id, a) => globalThis.__aiCtl.armDefer(id, a),
          args: [taskId, { ...action, taskId }],
        });
        armed = r && typeof r === "object" ? r : { ok: false, msg: "页面未响应" };
      } catch (err) {
        return { ok: false, msg: "无法在该页面挂载等待监听：" + (err.message || err) };
      }
      if (!armed.ok) return armed;

      let timeoutSec = 1800;
      try {
        let winId = null;
        try {
          const t = await chrome.tabs.get(tabId);
          winId = t && t.windowId != null ? t.windowId : null;
        } catch (_) {}
        const resp = await chrome.runtime.sendMessage({
          type: "defer:register",
          task: {
            id: taskId,
            instruction,
            until,
            tabId,
            windowId: winId,
            workspaceId: this.ws.id,
            timeoutSec: action.timeoutSec,
          },
        });
        if (resp && resp.timeoutSec) timeoutSec = resp.timeoutSec;
      } catch (err) {
        return { ok: false, msg: "后台任务注册失败：" + (err.message || err) };
      }
      const untilDesc =
        until.type === "video-ended"
          ? "视频播放结束"
          : until.type === "text-appear"
            ? `页面出现「${(until.text || "").slice(0, 20)}」`
            : until.type === "element-appear"
              ? `元素「${(until.text || "").slice(0, 20)}」出现`
              : until.type === "timeout"
                ? `${until.seconds || 60} 秒定时`
                : until.type;
      return {
        ok: true,
        deferred: true,
        taskId,
        msg: `已设置后台任务：等待${untilDesc}后自动继续（兜底超时 ${Math.round(timeoutSec / 60)} 分钟）`,
      };
    }

    let beforeUrl = "";
    try {
      const tab = await chrome.tabs.get(tabId);
      if (!tab || !/^https?:/.test(tab.url || "")) {
        return {
          ok: false,
          msg: "当前页面是浏览器内置页（新标签页/设置页等），无法执行元素操作。请先用 navigate 打开目标网站（http/https），跳转成功后再操作",
        };
      }
      beforeUrl = tab.url || "";
    } catch (_) {}

    let result;
    try {
      await injectScript(tabId, "content/control.js");
      const [{ result: r }] = await chrome.scripting.executeScript({
        target: { tabId },
        func: (a) => globalThis.__aiCtl.act(a),
        args: [action],
      });
      result = r && typeof r === "object" ? r : { ok: false, msg: "页面未响应动作" };
    } catch (err) {
      result = { ok: true, msg: "页面已跳转或重载，动作可能已生效：" + (err.message || err) };
    }

    const settled = await waitTabSettle(tabId, 6000);
    const afterUrl = settled?.url || "";
    const navigated = !!(beforeUrl && afterUrl && beforeUrl !== afterUrl);
    return { ...result, navigated, url: afterUrl, loading: settled?.status === "loading" };
  }

  // ===== 消息组装 =====
  buildMessages({ pageContext, snapshot, controlOn, userContentOverride, pendingImage, skipElementList }) {
    const msgs = [];
    let system = "你是浏览器侧边栏里的 AI 助手，用简洁的中文回答问题。";
    system += "\n【你的能力】用户消息里可能会附上图片、文档或屏幕截图，你都能直接看到/读到其中的内容。";

    const restricted = !!snapshot?.restricted;
    const failed = !!snapshot?.failed;
    const elements = snapshot?.elements || [];
    const ctlReady = controlOn && !restricted && !failed && elements.length > 0;

    if (controlOn) {
      system += "\n你可以操作当前网页：点击按钮、填写表单、下拉选择、勾选、按键、滚动、跳转网址、提取文本。";
      system += ACTION_PROTOCOL;
      if (restricted) {
        system += "\n【当前页面】" + (snapshot.title || "浏览器内置页") + "（" + snapshot.url + "）";
        system +=
          "\n注意：这是浏览器内置页面（如新标签页/设置页），无法读取其中的元素（上面元素列表为空），" +
          "但 navigate 动作照常可用——先用 navigate 打开目标网站（http/https），" +
          "跳转成功后系统会返回新页面的元素列表，然后再继续操作。" +
          "例如用户让你搜索/打开某网站时，直接 navigate 到对应网址即可。";
      } else if (ctlReady) {
        if (skipElementList) {
          system += "\n【可交互元素】见最近一条动作结果里的列表（编号以那里为准）。";
        } else {
          system += "\n【可交互元素】\n" + formatElements(elements);
        }
      } else if (failed) {
        system +=
          "\n注意：当前页面无法读取元素（可能加载失败）。" +
          (snapshot.unreachable
            ? "这通常是网址写错或站点无法访问（浏览器显示 DNS_PROBE_FINISHED_NXDOMAIN 等错误页）。" +
              "不要猜测域名，改用搜索引擎定位正确站点：输出 {\"action\":\"navigate\",\"url\":\"https://www.bing.com/search?q=<关键词>\"} " +
              "（或 https://www.google.com/search?q=<关键词>），然后在结果页点击正确链接；也可以直接向用户确认准确网址。"
            : "先按普通问答处理；如用户要求操作网页，可尝试用 navigate 打开目标网址后再操作。");
      } else {
        system += "\n注意：当前页面没有扫描到可交互元素，如需操作可尝试 navigate 到目标网址或用 extract 读取页面。";
      }
    } else {
      system +=
        "\n当前是纯问答模式（「操作」开关未开启）：你只能回答问题、分析内容，不能操作页面。" +
        "如果用户请你操作网页，请说明需要先在面板里打开「操作」开关。";
    }

    if (pageContext || snapshot) {
      const src = snapshot && snapshot.url ? snapshot : pageContext || {};
      system += "\n\n【当前页面】\n标题：" + (src.title || "") + "\nURL：" + (src.url || "");
    }
    if (pageContext && pageContext.selection) {
      system += "\n用户选中内容：\n" + pageContext.selection;
    }
    if (pageContext && pageContext.text) {
      system += "\n页面正文（可能截断）：\n" + pageContext.text;
    }

    msgs.push({ role: "system", content: system });

    const KEEP_FULL_RESULTS = 2;
    const totalResults = this.session.messages.filter((m) => m.isActionResult).length;
    let seenResults = 0;
    this.session.messages.forEach((h, i) => {
      const isTurnStart = i === this.session.messages.length - 1 && h.role === "user";
      let content = isTurnStart && userContentOverride ? userContentOverride : h.content;
      if (h.isActionResult && typeof content === "string") {
        seenResults++;
        if (totalResults - seenResults >= KEEP_FULL_RESULTS) content = stripElementLists(content);
      }
      msgs.push({ role: h.role === "error" ? "assistant" : h.role, content });
    });
    if (pendingImage) {
      msgs.push({
        role: "user",
        content: [
          { type: "text", text: "（这是当前页面截图，供你观察页面真实状态，仅本次可见、不会进入历史）" },
          { type: "image_url", image_url: { url: pendingImage, detail: "low" } },
        ],
      });
    }
    return msgs;
  }

  // ===== 一轮对话（含操作循环）=====
  async send(opts = {}) {
    const isWake = !!opts.wake;
    const text = String(opts.text || "").trim();
    if (!text && !(opts.attachments || []).length) return;
    if (this.busy) {
      if (isWake) this.wakeQueue.push(opts.wakePayload || { instruction: text, reason: "（排队唤醒）" });
      return;
    }

    const settings = await this.ctx.getSettings();
    // 每个工作区可以有自己的模型（用户要求：不同工作区用不同模型，且支持中途更改）
    const pid = this.ws.providerId || settings.activeProviderId;
    const mid = this.ws.modelId || settings.activeModelId;
    const provider = findProvider(settings, pid);
    if (!provider) {
      this.setStatus("供应商配置无效", "err");
      return;
    }
    const modelMeta = (provider.models || []).find((m) => m.id === mid);
    const modelVision = !!modelMeta?.vision;

    let shotBudget = 2;
    let autoShotUsed = false;
    let pendingImage = null;
    let lastOkAction = null;
    // 本轮开始时刻：用来界定"上一步是不是刚开了新标签页"
    const turnStartAt = Date.now();

    this.busy = true;
    this.compressedThisTurn = false; // 每轮重置：压缩只在需要时触发一次
    // 把"正在运行"写进共享存储并广播：别的侧栏文档实例（你切回来的那一份）
    // 才知道该显示"停止"按钮，而不是"发送"
    try {
      this.ctx.markBusy && this.ctx.markBusy(this.ws.id, true);
    } catch (_) {}
    this.ctx.onStateChange(this);

    const sentAttachments = isWake ? [] : (opts.attachments || []).slice();

    // 本轮目标：优先"用户此刻正在看的那一页"（只要它属于本工作区）。
    // 这一点很关键：用户在工作区里从 A 页切到 B 页再发消息，意图显然是操作 B 页，
    // 不能因为工作区根还记着 A 就去操作 A（那正是"控制错页面"的体感来源）。
    // 用户不在本工作区的任何一页上时，才退回工作区根。
    const activeNow = await this.ctx.activeTabId();
    const startId = activeNow != null && this.owns(activeNow) ? activeNow : this.ws.rootTabId;
    let targetTab = null;
    let tabId = null;
    try {
      targetTab = await chrome.tabs.get(startId);
    } catch (_) {
      targetTab = null;
    }
    tabId = targetTab?.id ?? startId;
    // 起始页没了但工作区还有别的页 → 用第一个活着的
    if (!this.owns(tabId)) {
      const alive = await this.ctx.getAliveTabs(this);
      if (!alive.length) {
        this.busy = false;
        this.ctx.onStateChange(this);
        this.setStatus("工作区里的标签页都已关闭", "err");
        return;
      }
      tabId = alive[0].id;
    }
    // 用户明确在当前页发了消息 → 它就是本工作区当前的主页面
    if (this.owns(tabId) && this.ws.rootTabId !== tabId) {
      this.ws.rootTabId = tabId;
      this.ctx.persist();
    }

    let pageContext = null;
    const ctxOn = this.ctx.toggleState().ctx;
    if (ctxOn) {
      this.setStatus("正在读取当前页面…", "busy");
      pageContext = await this.extractPageContext(tabId);
    }

    const ctlOn = this.ctx.toggleState().ctl;
    const controlOn = ctlOn && tabId != null;
    let snapshot = null;
    if (controlOn) {
      this.setStatus("正在分析页面元素…", "busy");
      snapshot = await getPageSnapshot(tabId);
    }
    this.targetPageLabel = (snapshot?.title || targetTab?.title || "").slice(0, 42);
    let lastSentSig = elementsSig(snapshot);

    if (
      controlOn &&
      snapshot &&
      !snapshot.restricted &&
      !(snapshot.elements || []).length &&
      modelVision &&
      shotBudget > 0
    ) {
      try {
        this.setStatus("页面元素暂不可读，正在截图确认…", "busy");
        pendingImage = await captureScreenshot(targetTab);
        shotBudget--;
        autoShotUsed = true;
      } catch (_) {}
    }

    let screenshotDataUrl = null;
    const shotOn = this.ctx.toggleState().shot;
    if (shotOn) {
      this.setStatus("正在截图…", "busy");
      try {
        screenshotDataUrl = await captureScreenshot(targetTab);
      } catch (err) {
        this.setStatus("截图失败：" + (err.message || err), "err");
      }
    }

    const textParts = [];
    if (text) textParts.push(text);
    for (const a of sentAttachments) {
      if (a.kind === "text") {
        textParts.push(`【文档 ${a.name}${a.truncated ? "（已截断）" : ""}】\n${a.text}`);
      }
    }
    const joinedText = textParts.join("\n\n") || "请分析附件内容。";

    const imageBlocks = [];
    for (const a of sentAttachments) {
      if (a.kind === "image" && a.dataUrl) {
        imageBlocks.push({ type: "image_url", image_url: { url: a.dataUrl, detail: "low" } });
      }
    }
    if (screenshotDataUrl) {
      imageBlocks.push({ type: "image_url", image_url: { url: screenshotDataUrl, detail: "low" } });
    }
    const userContent = imageBlocks.length
      ? [{ type: "text", text: joinedText }, ...imageBlocks]
      : joinedText;

    const noteBits = [];
    for (const a of sentAttachments) {
      noteBits.push(a.kind === "image" ? `图片 ${a.name}` : `文档 ${a.name}`);
    }
    if (screenshotDataUrl) noteBits.push("屏幕截图");
    const attachNote = noteBits.length ? "[附带：" + noteBits.join("、") + "，图片仅本条消息可见]" : "";

    const displayText = isWake ? (opts.displayText || text) : text || "（附件内容）";
    this.createUserBubble(displayText, { attachNote });

    this.session.messages.push({ role: "user", content: text || displayText, attachNote });
    if (this.session.messages.filter((m) => !m.isActionResult).length === 1) {
      this.session.title = (displayText || "对话").slice(0, 30);
    }

    // 目标页边界检测
    // lastActionAt：上一次动作发生的时刻。只有"那之后"新开的子标签页才算"上一步开了新页"。
    // 起始基线 = 本轮开始时刻，这样上一轮遗留的记录不会被当成"刚刚开了新页"，
    // 从而把正常动作误判成"目标页已切换"拦下来（E2E S12 踩过这个坑）。
    let lastActionAt = turnStartAt;
    const checkTargetBoundary = async () => {
      const childId = this.peekOpenedChild(tabId, lastActionAt);
      if (childId != null && childId !== tabId) {
        this.markChildHandled(childId);
        const child = await describeTab(childId);
        if (child && child.id && /^https?:/.test(child.url || "")) {
          // AI 打开的标签页 → 并入本工作区（用户明确要求）
          if (this.addTab(child.id)) this.ctx.persist();
          targetTab = child;
          tabId = child.id;
          return {
            cardNote: "目标页已切换：上一步打开了新标签页",
            modelNote:
              "【动作执行结果】未执行：上一步的操作打开了一个新标签页，已自动接管为当前目标页面：" +
              (child.title || "(无标题)") +
              " — " +
              child.url +
              "。元素编号已全部重新分配，请依据下面最新的元素列表重新决定下一步。",
          };
        }
      }
      const pre = await preflightTarget(tabId, snapshot?.url || "");
      if (pre.dead) {
        return {
          cardNote: "目标标签页已被关闭",
          modelNote:
            "【动作执行结果】未执行：目标标签页已经被关闭了。" +
            "不要继续使用旧编号。请先用 navigate 打开目标网址，或询问用户要打开哪个页面。",
        };
      }
      if (pre.changed) {
        return {
          cardNote: "目标页已变化，本次动作未执行",
          modelNote:
            "【动作执行结果】未执行：目标页面现在已经是另一个页面了（当前：" +
            (pre.title || "(无标题)") +
            " — " +
            pre.url +
            "），可能是用户自己切换/跳转了页面。为防止点到错误的元素，本次动作被拦下。" +
            "元素编号已全部重新分配，请依据下面最新的元素列表重新决定下一步。",
        };
      }
      return null;
    };

    try {
      let stuckKey = null;
      let stuckCount = 0;
      let formatErrCount = 0;

      for (let step = 0; ; step++) {
        const ui = this.createAssistantBubble();
        const messages = this.buildMessages({
          pageContext,
          snapshot,
          controlOn: controlOn && !!snapshot,
          userContentOverride: step === 0 ? userContent : undefined,
          pendingImage,
          skipElementList: step > 0,
        });
        pendingImage = null;

        // ===== 记忆压缩（用户要求：快达到总 token 的 90% 就自动压缩）=====
        // 命中后重建一次 messages（用压缩过的历史），保证这次请求不超上限。
        if (!this.compressedThisTurn) {
          const win = Number(settings.contextWindow) || 128000;
          const ratio = Math.min(0.98, Math.max(0.5, Number(settings.autoCompressAt) || 0.9));
          if (estimateMessages(messages) >= win * ratio) {
            const okCompress = await this.compressMemory(provider, mid);
            if (okCompress) {
              this.compressedThisTurn = true;
              const again = this.buildMessages({
                pageContext,
                snapshot,
                controlOn: controlOn && !!snapshot,
                userContentOverride: step === 0 ? userContent : undefined,
                pendingImage: null,
                skipElementList: step > 0,
              });
              messages.length = 0;
              messages.push(...again);
            }
          }
        }

        this.abortController = new AbortController();
        let acc = "";
        let reasoningAcc = "";
        let thinkingOpen = false;
        let keyLabel = "";

        this.setStatus(step === 0 ? "正在生成…" : `继续执行…（第 ${step + 1} 步）`, "busy");
        try {
          const res = await (async () => {
            // 失败处理链（用户要求）：
            //   同一模型最多重试 5 次（等 5s/6s/7s/8s/9s）→ 还不行就自动换下一个模型，
            //   换过去的模型同样再重试 5 次，直到成功或用尽候选模型。
            const modelQueue = buildModelQueue(provider, mid);
            const baseWait = Number(settings.retryWaitSec) >= 0 ? Number(settings.retryWaitSec) : 5;
            const maxRetries = Number(settings.retryMax) > 0 ? Number(settings.retryMax) : MAX_AI_RETRIES;
            let lastErr = null;
            for (let mi = 0; mi < modelQueue.length; mi++) {
              const useModel = modelQueue[mi];
              if (mi > 0) {
                this.addNoteBubble(
                  `模型「${modelQueue[mi - 1]}」连续失败，已自动切换到「${useModel}」继续`
                );
                this.setStatus(`已切换到模型「${useModel}」重试…`, "busy");
              }
              for (let attempt = 0; ; attempt++) {
                try {
                  return await chatStream({
                    provider,
                    model: useModel,
                    messages,
                    signal: this.abortController.signal,
                    thinkingEnabled: this.ctx.toggleState().think,
                    onReasoning: (delta) => {
                      reasoningAcc += delta;
                      if (!thinkingOpen) {
                        ui.setThinking(reasoningAcc, { streaming: true, open: true });
                        thinkingOpen = true;
                      } else {
                        ui.appendThinking(delta);
                      }
                      this.scrollChat();
                    },
                    onDelta: (delta, full) => {
                      acc = full;
                      ui.collapseThinking();
                      ui.setStreamingAnswer(acc);
                    },
                  });
                } catch (err) {
                  lastErr = err;
                  if (!isRetryable(err)) throw err;
                  if (attempt >= maxRetries) break; // 这个模型放弃 → 换下一个
                  const waitSec = baseWait + attempt; // 第 1 次等 5s，第 2 次 6s，依此类推
                  // 丢掉这次已经流出来半截的内容，避免和重试结果串在一起
                  acc = "";
                  reasoningAcc = "";
                  thinkingOpen = false;
                  ui.endStreamingAnswer();
                  ui.finishThinking();
                  this.setStatus(
                    `请求失败，${waitSec} 秒后重试（第 ${attempt + 1}/${maxRetries} 次）…`,
                    "err"
                  );
                  this.addNoteBubble(
                    `AI 请求失败：${(err && err.message) || err}\n将在 ${waitSec} 秒后自动重试（第 ${attempt + 1}/${maxRetries} 次）`
                  );
                  await sleepAbortable(waitSec * 1000, this.abortController.signal);
                  this.setStatus(`正在重试（第 ${attempt + 1}/${maxRetries} 次）…`, "busy");
                }
              }
            }
            throw lastErr || new Error("所有候选模型都失败了");
          })();
          keyLabel = res.keyLabel || "默认 Key";
        } catch (err) {
          if (err.name === "AbortError") {
            ui.endStreamingAnswer();
            ui.finishThinking();
            if (acc) {
              ui.setAnswer(acc);
              this.session.messages.push({
                role: "assistant",
                content: acc,
                finalText: acc,
                reasoning: reasoningAcc || undefined,
                steps: [],
              });
            } else {
              ui.remove();
            }
            this.setStatus("已取消", "");
            await this.ctx.saveSession(this.session);
            return;
          }
          throw err;
        }

        ui.endStreamingAnswer();
        ui.finishThinking();
        const metaText = "由 " + keyLabel + " 响应";

        const parsed = extractAction(acc);
        if (parsed && parsed.parseError) {
          ui.setAnswer(acc);
          ui.setMeta(metaText);
          formatErrCount++;
          if (formatErrCount > 2) {
            this.addErrorBubble(
              `连续 ${formatErrCount} 次没能解析出合法动作，已停止。` + "可能是模型输出格式有问题，请重新发一次消息试试。"
            );
            await this.ctx.saveSession(this.session);
            this.setStatus("动作格式反复出错，已停止", "err");
            return;
          }
          const reason = parsed.reason || "动作格式不对";
          const errMsg =
            `【动作执行结果】你的动作没被执行：${reason}。` +
            "请重新输出一个动作代码块，严格按这个格式（只输出一个动作，JSON 要合法）：" +
            '{"action":"click","target":3}';
          this.session.messages.push({
            role: "assistant",
            content: acc,
            finalText: acc,
            reasoning: reasoningAcc || undefined,
            meta: metaText,
            steps: [],
          });
          this.session.messages.push({ role: "user", content: errMsg, isActionResult: true });
          await this.ctx.saveSession(this.session);
          this.setStatus("动作格式有误，已让 AI 重试", "err");
          continue;
        }
        if (!parsed) {
          ui.setAnswer(acc);
          ui.setMeta(metaText);
          this.session.messages.push({
            role: "assistant",
            content: acc,
            finalText: acc,
            reasoning: reasoningAcc || undefined,
            meta: metaText,
            steps: [],
          });
          await this.ctx.saveSession(this.session);
          this.setStatus("");
          return;
        }

        formatErrCount = 0;
        const preText = (parsed.before || "").trim();
        const action = parsed.data;
        const finalText = (parsed.after || "").trim();

        const reportBoundary = async (card, boundary) => {
          snapshot = await getPageSnapshot(tabId);
          this.targetPageLabel = (snapshot?.title || targetTab?.title || "").slice(0, 42);
          if (card) card.setState("cancelled", boundary.cardNote);
          this.scrollChat();
          const stepRec = { preText, action, result: { ok: false, blocked: true, msg: boundary.cardNote } };
          this.session.messages.push({
            role: "assistant",
            content: acc,
            finalText,
            reasoning: reasoningAcc || undefined,
            meta: metaText,
            steps: [stepRec],
          });
          let note = boundary.modelNote;
          if (snapshot && snapshot.elements?.length) {
            const sig = elementsSig(snapshot);
            if (sig === lastSentSig) {
              note += "\n【页面元素】与上一次相同，编号沿用。";
            } else {
              lastSentSig = sig;
              note += `\n【当前可交互元素】\n${formatElements(snapshot.elements)}`;
            }
          } else {
            note += '\n当前页面读不到可交互元素，可先输出 {"action":"wait","ms":1500} 再尝试。';
          }
          this.session.messages.push({ role: "user", content: note, isActionResult: true });
          await this.ctx.saveSession(this.session);
          this.setStatus("目标页已变化，动作未执行", "");
        };

        ui.setAnswer(preText);
        ui.setMeta(metaText);

        const actionKey = JSON.stringify([
          action.action,
          action.target ?? null,
          action.value ?? null,
          action.url ?? null,
          action.key ?? null,
        ]);
        const isRepeat =
          lastOkAction &&
          lastOkAction.key === actionKey &&
          Date.now() - lastOkAction.at < 30000 &&
          ["click", "press", "check", "select"].includes(action.action);

        if (isRepeat) {
          const skippedCard = ui.addToolCard(action);
          skippedCard.setState("cancelled", "已跳过：与上一步重复的动作（上一步已成功）");
          this.scrollChat();
          const stepRec = { preText, action, result: { ok: false, skipped: true, msg: "重复动作已跳过" } };
          this.session.messages.push({
            role: "assistant",
            content: acc,
            finalText,
            reasoning: reasoningAcc || undefined,
            meta: metaText,
            steps: [stepRec],
          });
          this.session.messages.push({
            role: "user",
            content:
              "【动作执行结果】已跳过：与上一步完全相同的动作，且上一步已成功（页面可能已跳转或正在加载）。" +
              '请不要重复操作。需要确认页面状态时先输出 {"action":"wait","ms":1500}，再依据最新元素列表判断下一步。',
            isActionResult: true,
          });
          snapshot = await getPageSnapshot(tabId);
          this.targetPageLabel = (snapshot?.title || targetTab?.title || "").slice(0, 42);
          await this.ctx.saveSession(this.session);
          continue;
        }

        let boundary = await checkTargetBoundary();
        if (boundary) {
          const guardCard = ui.addToolCard(action);
          await reportBoundary(guardCard, boundary);
          continue;
        }

        const card = ui.addToolCard(action);
        this.scrollChat();

        this.setStatus("等待确认操作…", "busy");
        const proceed = await this.confirmAction(card, this.ctx.toggleState().auto, this.abortController.signal);

        const stepRec = { preText, action, result: null };
        if (!proceed) {
          stepRec.result = { ok: false, cancelled: true, msg: "用户取消了该动作" };
          card.setState("cancelled", "已取消");
          const resultMsg = "【动作执行结果】用户取消了该动作。请直接给出说明或询问用户下一步。";
          this.session.messages.push({
            role: "assistant",
            content: acc,
            finalText,
            reasoning: reasoningAcc || undefined,
            meta: metaText,
            steps: [stepRec],
          });
          this.session.messages.push({ role: "user", content: resultMsg, isActionResult: true });
          await this.ctx.saveSession(this.session);
          this.setStatus("已取消操作", "");
          return;
        }

        boundary = await checkTargetBoundary();
        if (boundary) {
          await reportBoundary(card, boundary);
          continue;
        }

        this.setStatus("正在执行操作…", "busy");
        await setBanner(tabId, true);
        // 记下动作时刻：之后只有"这之后"新开的子标签页才算"上一步开了新页"
        lastActionAt = Date.now();
        // 同时记到运行时上（侧栏判断"这个新页是不是 AI 弹出来的"要用它）
        this.lastActionAt = lastActionAt;
        const result = await this.runPageAction(tabId, action);

        const storedResult = { ...result };
        delete storedResult.screenshot;
        stepRec.result = storedResult;
        card.setResult(storedResult);

        if (result.deferred) {
          this.activeDeferTask = {
            id: result.taskId,
            instruction: (action.instruction || "").trim(),
            until: action.until,
            workspaceId: this.ws.id,
            tabId,
          };
          this.ctx.onDeferChange(this);
          this.session.messages.push({
            role: "assistant",
            content: acc,
            finalText,
            reasoning: reasoningAcc || undefined,
            meta: metaText,
            steps: [stepRec],
          });
          this.session.messages.push({
            role: "user",
            content:
              `【动作执行结果】成功：${result.msg}。` +
              "\n本轮对话到此结束（不要输出其它动作）。等条件满足后系统会自动唤醒你，" +
              "届时根据【后台任务唤醒】消息继续执行后续指令。",
            isActionResult: true,
          });
          await this.ctx.saveSession(this.session);
          this.setStatus("后台任务等待中，条件满足后自动继续", "busy");
          this.addNoteBubble(result.msg + "（可在上方提示条取消）");
          return;
        }

        if (["wait", "scroll", "extract"].includes(action.action)) {
          lastOkAction = null;
        } else if (result.ok && ["click", "press", "check", "select", "fill"].includes(action.action)) {
          lastOkAction = { key: actionKey, at: Date.now() };
        }

        this.session.messages.push({
          role: "assistant",
          content: acc,
          finalText,
          reasoning: reasoningAcc || undefined,
          meta: metaText,
          steps: [stepRec],
        });

        snapshot = await getPageSnapshot(tabId);
        this.targetPageLabel = (snapshot?.title || targetTab?.title || "").slice(0, 42);

        let resultMsg = `【动作执行结果】${result.ok ? "成功" : "失败"}：${result.msg || ""}`;
        if (result.hint) resultMsg += `\n建议：${result.hint}`;
        if (result.navigated) {
          resultMsg += `\n页面已跳转，当前 URL：${result.url || "(未知)"}。这是本次动作已经生效的信号，不要再重复执行同一个动作。`;
        }
        if (result.loading) {
          resultMsg +=
            '\n注意：页面仍在加载中，先不要判断成败、也不要重复点击；可先输出 {"action":"wait","ms":1500} 等待后再观察。';
        }
        if (result.data) resultMsg += `\n【提取内容】\n${String(result.data).slice(0, 2000)}`;

        if (result.screenshot) {
          if (modelVision && shotBudget > 0) {
            shotBudget--;
            pendingImage = result.screenshot;
            resultMsg += "\n已附带当前页面截图（仅本次可见，不进历史）。";
          } else {
            resultMsg += "\n（当前模型不支持看图或截图预算已用完，截图已丢弃；请改用元素列表或 extract 获取信息）";
          }
        }

        // 工作区里有哪些标签页（只列本工作区的，跨区不可见）
        const scopeList = await this.ctx.getAliveTabs(this);
        if (scopeList.length > 1) {
          const rows = scopeList
            .map((t, i) => {
              const cur = t.id === tabId ? " ←当前" : "";
              return `  [${i}] ${(t.title || t.url || "未命名").slice(0, 36)}${cur}`;
            })
            .join("\n");
          resultMsg += `\n【AI 工作区的标签页】你只能操作下面这些标签页（switchtab 切换）：\n${rows}`;
        }

        if (snapshot && snapshot.elements?.length) {
          const sig = elementsSig(snapshot);
          if (sig === lastSentSig) {
            resultMsg += "\n【页面元素】与上一次完全相同，编号沿用，无需重新观察。";
          } else {
            lastSentSig = sig;
            resultMsg += `\n【最新可交互元素】\n${formatElements(snapshot.elements)}`;
            if (snapshot.truncated && snapshot.total) {
              resultMsg +=
                `\n（页面上一共有 ${snapshot.total} 个可交互元素，上面只列出了 ${snapshot.elements.length} 个` +
                "最相关的。列表里没有你要找的目标时，用 find 动作按文字找它：" +
                '{"action":"find","text":"关键词"}）';
            }
          }
        } else {
          if (snapshot && snapshot.unreachable) {
            resultMsg +=
              "\n这个页面可能加载失败（DNS 错误 / 无法访问），通常是网址写错。" +
              "不要继续猜域名：改用搜索引擎定位正确站点，" +
              '例如 {"action":"navigate","url":"https://www.bing.com/search?q=<关键词>"}，或向用户确认准确网址。';
          }
          resultMsg +=
            "\n当前页面读不到可交互元素（可能未加载完，或内容在画布/跨域框架里）。" +
            '请先输出 {"action":"wait","ms":1500} 再确认，不要重复点击；多次仍为空时可改用 screenshot 查看页面。';
          if (modelVision && !autoShotUsed && shotBudget > 0 && !snapshot?.unreachable) {
            autoShotUsed = true;
            shotBudget--;
            try {
              pendingImage = await captureScreenshot(targetTab);
              resultMsg += "\n已附上当前页面截图，供你判断页面真实状态。";
            } catch (_) {}
          }
        }
        this.session.messages.push({ role: "user", content: resultMsg, isActionResult: true });
        await this.ctx.saveSession(this.session);

        if (result.ok) {
          stuckKey = null;
          stuckCount = 0;
        } else if (stuckKey === actionKey) {
          stuckCount++;
          if (stuckCount >= MAX_STUCK_FAILS) {
            this.addErrorBubble(
              `这个动作已经连续失败 ${stuckCount} 次，再试下去只是浪费，已停下。` +
                "可能是页面结构不符合预期或需要你介入（比如登录、验证码），" +
                "你可以补充说明或换个做法让我继续。"
            );
            await this.ctx.saveSession(this.session);
            this.setStatus("反复失败，已停止", "err");
            return;
          }
        } else {
          stuckKey = actionKey;
          stuckCount = 1;
        }
      }
    } catch (err) {
      this.addErrorBubble("出错了：" + (err.message || err));
      this.setStatus("请求失败", "err");
    } finally {
      this.busy = false;
      this.abortController = null;
      this.pendingConfirm = null;
      // 清掉共享的"正在运行"标记（别的面板实例据此恢复"发送"按钮）
      try {
        this.ctx.markBusy && this.ctx.markBusy(this.ws.id, false);
      } catch (_) {}
      this.ctx.onStateChange(this);
      setBanner(tabId, false).catch(() => {});
      // 唤醒排队：本轮结束后把等待中的唤醒接上
      if (this.wakeQueue.length && !this.busy) {
        const wake = this.wakeQueue.shift();
        this.activeDeferTask = null;
        this.ctx.onDeferChange(this);
        setTimeout(() => {
          this.wake(wake).catch(() => {});
        }, 120);
        return;
      }
      // 另一个面板实例转过来的消息（那份面板正在跑这一份工作区）：
      // 本轮结束后接着把它们发出去，这样用户"发的消息"不会石沉大海。
      if (this.pendingSends.length && !this.busy) {
        const next = this.pendingSends.shift();
        setTimeout(() => {
          this.send(next).catch(() => {});
        }, 120);
      }
    }
  }

  // ===== 记忆压缩（用户要求：快达到总 token 的 90% 时自动压缩）=====
  //
  // 做法：把"较早的历史"交给模型压成一份紧凑摘要，保留最近几轮原文。
  // 这样后续请求不再携带全量历史，既能继续干活，也不会爆上下文。
  async compressMemory(provider, modelId) {
    if (this.compressing) return false;
    this.compressing = true;
    const prevStatus = this.status;
    this.setStatus("上下文接近上限，正在压缩记忆…", "busy");
    try {
      const all = this.session.messages || [];
      // 尾部保留最近 4 条"真实对话"（不含动作结果），它们是当前工作的上下文
      const keep = [];
      for (let i = all.length - 1; i >= 0 && keep.length < 4; i--) {
        if (!all[i].isActionResult) keep.unshift(all[i]);
      }
      const keepSet = new Set(keep);
      const head = all.filter((m) => !keepSet.has(m));
      if (!head.length) return false;

      // 拼成可读的对话记录（动作结果里的元素列表先裁掉，避免又塞满一遍）
      const lines = [];
      let budget = 60000; // 压缩请求自身的字符预算（约 3 万 token 内）
      for (const m of head) {
        const role = m.role === "user" ? "用户" : m.role === "assistant" ? "助手" : "系统";
        const body = stripElementLists(
          typeof m.content === "string" ? m.content : JSON.stringify(m.content || "")
        ).slice(0, 1200);
        const line = `【${role}】${body}`;
        if (budget - line.length < 0) break;
        budget -= line.length;
        lines.push(line);
      }
      if (!lines.length) return false;

      const sys =
        "你是对话记忆压缩器。把给你的历史对话压缩成一份**紧凑、可继续工作**的记忆。要求：\n" +
        "1) 保留：用户的真实目标与约束、已经完成的步骤与结果、页面/表单的关键状态、" +
        "待办步骤、重要数据（编号、链接、文件路径、表单值）；\n" +
        "2) 丢掉：寒暄、重复的解释、失败尝试的细节、已被后续步骤覆盖的中间状态；\n" +
        "3) 用条目化中文，控制在 600 字以内；\n" +
        "4) 只输出摘要正文，不要加“好的/以下是”这类客套。";

      const res = await chatStream({
        provider,
        model: modelId,
        messages: [
          { role: "system", content: sys },
          { role: "user", content: lines.join("\n") },
        ],
        signal: this.abortController ? this.abortController.signal : undefined,
        thinkingEnabled: false,
        onDelta: () => {},
      });
      const summary = String((res && res.text) || "").trim();
      if (!summary) return false;

      this.session.messages = [
        {
          role: "user",
          content:
            "【历史记忆（已自动压缩，等价于之前的全部对话）】\n" +
            summary +
            "\n（以上是对之前对话的压缩摘要；下面继续。）",
          isCompressed: true,
        },
        ...keep,
      ];
      this.session.compressedAt = Date.now();
      await this.ctx.saveSession(this.session);
      // 重绘（若这份不是当前显示的那份，画的也是它自己的 DOM；
      // 切回来时自愈逻辑会按 storage 再同步一次）
      this.renderSession();
      this.addNoteBubble("上下文接近上限，已自动压缩历史记忆（摘要 + 最近几轮）");
      return true;
    } catch (_) {
      return false;
    } finally {
      this.compressing = false;
      this.setStatus(prevStatus.text, prevStatus.kind);
    }
  }

  // 后台任务唤醒：当成一条用户消息，走完整循环继续执行
  async wake(wake) {
    if (!wake) return;
    // 任务已经被触发，就不再是"等待中"了 → **立刻收起提示条**。
    // 以前只有"排队唤醒"那条路径才清 activeDeferTask，所以后台任务真正跑起来之后
    // 横条会一直挂在面板上（用户反馈："后台任务执行后上面的横条还显示着"）。
    this.activeDeferTask = null;
    this.ctx.onDeferChange(this);
    const reason = wake.reason || "等待条件已满足";
    const instruction = (wake.instruction || "").trim();
    const text =
      `【后台任务唤醒】${reason}。\n` +
      (instruction
        ? `请继续执行之前安排好的后续任务：${instruction}`
        : "请根据之前的对话继续把任务做完。") +
      "\n（这是系统自动唤醒，不是用户输入；先观察页面现状再继续操作，不要重复已经做过的步骤）";
    await this.send({ text, displayText: `⏰ 后台任务唤醒：${reason}`, wake: true, wakePayload: wake });
  }

  abort() {
    this.abortController?.abort();
    if (this.pendingConfirm) this.pendingConfirm(false);
  }

  destroy() {
    try {
      this.abort();
    } catch (_) {}
    this.chatEl.remove();
  }
}

// 写剪贴板：优先用异步 API（扩展页有权限），失败退回 execCommand
async function writeClipboard(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch (_) {}
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.cssText = "position:fixed;left:-9999px;top:0;opacity:0;";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    return ok;
  } catch (_) {
    return false;
  }
}
