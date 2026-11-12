// 浏览器原生弹窗接管钩子（运行在**页面自己的世界**：MAIN world · document_start · 所有框架）
//
// 要解决的问题：alert / confirm / prompt / 「离开站点？」这四种框**不是网页里的元素**，
// 是浏览器自己画的模态框。它们一出现就把这个标签页的主线程**整条按住**：
//   · 页面 JS 停住 → 侧栏注入什么都拿不到结果（表现就是"点了按钮之后整个侧栏卡死"）；
//   · 它不在 DOM 里 → snapshot / a11y / 截图之外的任何读取都看不见它，更没法点它。
// 所以侧栏对它是"零控制"。这个脚本把四个入口换成可控版本：
//   ① 内容照记（写进 data-qn-dlg-log 这本账，侧栏/AI 随时读得到）；
//   ② 页面上以提示条显示给人看（不至于"点了没反应、话也没了"）；
//   ③ **同步返回一个答案**立刻放行，绝不停住主线程。
// confirm / prompt 的答案可以由 AI 预先"下注"（arm）：先 arm 再点，点出来的框就按预设回答。
//
// 是否接管在每个**调用时刻**现读 DOM 属性（不靠重新注入）：
//   data-qn-dlg-cfg   由 dialog-bridge.js 从设置里抄过来 —— mode: ai(默认)/auto/off + 默认答案
//   data-qn-dlg-live  由 control.js 写 —— AI 正在操控这页的心跳（接管只在干活期间发生）
//   data-qn-dlg-ctl   由 control.js 写 —— AI 给下一个框预设的答案（用掉即从这本里摘掉）
// live 与 ctl 分家是有原因的：心跳每步都要续写，而"预设"是钩子用完就该消失的临时值；
// 挤在同一本里，顶层框架续心跳时会把某个子框架**已经用掉的预设又写回去**（等于复活一次答案）。
// 默认 ai 模式：只有 AI 在这页干活时才接管，用户自己浏览时仍旧是浏览器原生弹窗（不打扰、不越权）。
(() => {
  if (window.__qnDialogHook) return;
  try {
    Object.defineProperty(window, "__qnDialogHook", { value: true, configurable: true });
  } catch (_) {
    window.__qnDialogHook = true;
  }

  const CFG = "qn-dlg-cfg";
  const CTL = "qn-dlg-ctl";
  const LIVE = "qn-dlg-live";
  const LOG = "qn-dlg-log";
  const ENV = "qn-dlg-env";
  const MAX_LOG = 12; // 一本账最多记多少条（环形，够侧栏读最近的了）
  const MAX_MSG = 300; // 单条弹窗文字截断
  const ARM_DEFAULT_MS = 30000; // 预设答案的有效期：AI 下了注但页面迟迟没弹 → 过期作废
  const ARM_MAX_MS = 120000;
  const AI_DEFAULT_TTL = 90000; // 心跳过期：面板万一没了，90 秒后自动把弹窗还给用户
  const AI_MAX_TTL = 600000;

  const rootEl = () => document.documentElement || document;

  function getAttr(name) {
    const el = rootEl();
    try {
      return el && el.getAttribute ? el.getAttribute("data-" + name) : null;
    } catch (_) {
      return null;
    }
  }

  function setAttr(name, val) {
    const el = rootEl();
    if (!el || !el.setAttribute) return;
    try {
      if (val == null) el.removeAttribute("data-" + name);
      else el.setAttribute("data-" + name, String(val));
    } catch (_) {}
  }

  function readJson(name) {
    const raw = getAttr(name);
    if (!raw) return {};
    try {
      const o = JSON.parse(raw);
      return o && typeof o === "object" ? o : {};
    } catch (_) {
      return {};
    }
  }

  function str(x) {
    if (x == null) return "";
    try {
      return String(x);
    } catch (_) {
      return "";
    }
  }

  function clip(s, n) {
    const t = str(s);
    return t.length > n ? t.slice(0, n) + "…" : t;
  }

  function frameTag() {
    try {
      if (window.top === window) return "";
    } catch (_) {
      /* 跨域比较本身是允许的，抛了就算了 */
    }
    return "框架:" + (clip(location.host || location.protocol, 28) || "iframe");
  }

  // ===== 这本账就是 DOM 属性（不是内存）=====
  // 这样 control.js（隔离世界）任何时候注入进来都读得到"刚才弹过什么"，
  // 侧栏没开、面板崩了重开，账也还在页面上。
  function readLog() {
    const st = readJson(LOG);
    if (!Array.isArray(st.items)) st.items = [];
    st.seq = Number(st.seq) || 0;
    return st;
  }

  function push(rec) {
    const st = readLog();
    st.seq += 1;
    rec.seq = st.seq;
    rec.at = Date.now();
    rec.frame = frameTag();
    st.items.push(rec);
    while (st.items.length > MAX_LOG) st.items.shift();
    try {
      setAttr(LOG, JSON.stringify(st));
    } catch (_) {}
    return rec;
  }

  // ===== 当前策略（每次调用现读）=====
  function policy() {
    const cfg = readJson(CFG);
    const live = readJson(LIVE);
    const ctl = readJson(CTL);
    const mode = cfg.mode === "auto" || cfg.mode === "off" ? cfg.mode : "ai";
    const ttl = Math.min(AI_MAX_TTL, Math.max(15000, Number(live.ttl) || AI_DEFAULT_TTL));
    const aiOn = live.ai === 1 && Date.now() - (Number(live.at) || 0) < ttl;
    return {
      mode,
      aiOn,
      // 接管与否：auto 一直接管；ai 只在 AI 操控这页时接管；off 交还浏览器
      take: mode === "auto" || (mode === "ai" && aiOn),
      confirmAccept: cfg.confirmAccept === true,
      // prompt 的兜底答案：没配文字就是"取消"（null），配了就用它
      promptText: typeof cfg.promptText === "string" && cfg.promptText !== "" ? cfg.promptText : null,
      arm: readArm(ctl),
    };
  }

  function readArm(ctl) {
    const a = ctl && ctl.arm;
    if (!a || typeof a !== "object") return null;
    const ms = Math.min(ARM_MAX_MS, Math.max(5000, Number(a.ms) || ARM_DEFAULT_MS));
    if (Date.now() - (Number(a.at) || 0) > ms) return null;
    return a;
  }

  // 预设答案只用一次：用完就从 ctl 里摘掉（避免下一个不相干的框也被它答了）
  function consumeArm() {
    const ctl = readJson(CTL);
    if (!ctl.arm) return;
    delete ctl.arm;
    try {
      setAttr(CTL, JSON.stringify(ctl));
    } catch (_) {}
  }

  function armMatches(a, kind) {
    if (!a) return false;
    return !a.kind || a.kind === "any" || a.kind === kind;
  }

  const KIND_CN = {
    alert: "提示框 alert",
    confirm: "确认框 confirm",
    prompt: "输入框 prompt",
    beforeunload: "离开页面确认",
  };

  // ===== 给人看的提示条（Shadow DOM，不吃页面样式；用 inline style 躲开页面 CSP）=====
  const HOST_ID = "__qn_dlg_toast";
  let lastToast = { key: "", at: 0 };

  function ensureHost() {
    let host = document.getElementById(HOST_ID);
    if (host) return host;
    host = document.createElement("div");
    host.id = HOST_ID;
    host.style.cssText =
      "all:initial;position:fixed;left:12px;bottom:12px;z-index:2147483647;display:flex;" +
      "flex-direction:column;gap:8px;max-width:min(420px,72vw);pointer-events:none;";
    host.attachShadow({ mode: "open" });
    (document.body || document.documentElement).appendChild(host);
    return host;
  }

  function toast(rec) {
    const key = rec.kind + "|" + rec.msg;
    if (key === lastToast.key && Date.now() - lastToast.at < 4000) return; // 同一句话连弹别刷屏
    lastToast = { key, at: Date.now() };
    let host;
    try {
      host = ensureHost();
    } catch (_) {
      return;
    }
    if (!host.shadowRoot) return;
    const card = document.createElement("div");
    card.style.cssText = [
      "pointer-events:auto",
      "padding:10px 12px",
      "border-radius:10px",
      "font:500 12.5px/1.55 -apple-system,'Segoe UI','Microsoft YaHei',sans-serif",
      "color:#04211d",
      "background:linear-gradient(135deg,#ecfdf9,#ccfbf1)",
      "border:1px solid rgba(13,148,136,.35)",
      "box-shadow:0 8px 28px rgba(2,44,39,.22)",
      "word-break:break-word",
    ].join(";");
    const head = document.createElement("div");
    head.style.cssText = "display:flex;align-items:center;gap:6px;font-weight:700;margin-bottom:4px;color:#0f766e;";
    const dot = document.createElement("span");
    dot.style.cssText = "width:7px;height:7px;border-radius:50%;background:#14b8a6;flex:none;";
    head.appendChild(dot);
    head.appendChild(document.createTextNode((KIND_CN[rec.kind] || rec.kind) + (rec.frame ? " · " + rec.frame : "")));
    const body = document.createElement("div");
    body.style.cssText = "color:#0b3b34;white-space:pre-wrap;";
    body.textContent = rec.msg || "（空内容）";
    const tail = document.createElement("div");
    tail.style.cssText = "margin-top:5px;color:#0f766e;opacity:.85;";
    tail.textContent = "青鸟已替你处理：" + (rec.answer || "已关闭") + "（" + (rec.by || "自动") + "）";
    card.appendChild(head);
    card.appendChild(body);
    card.appendChild(tail);
    host.shadowRoot.appendChild(card);
    while (host.shadowRoot.childElementCount > 4) {
      try {
        host.shadowRoot.removeChild(host.shadowRoot.firstElementChild);
      } catch (_) {
        break;
      }
    }
    const ttl = Math.min(14000, 5200 + Math.min(6000, str(rec.msg).length * 45));
    setTimeout(() => {
      try {
        card.style.transition = "opacity .35s";
        card.style.opacity = "0";
        setTimeout(() => {
          try {
            if (card.parentNode) card.parentNode.removeChild(card);
          } catch (_) {}
        }, 400);
      } catch (_) {}
    }, ttl);
  }

  // ===== 四个入口 =====
  const native = {
    alert: typeof window.alert === "function" ? window.alert : null,
    confirm: typeof window.confirm === "function" ? window.confirm : null,
    prompt: typeof window.prompt === "function" ? window.prompt : null,
    addEL: typeof window.addEventListener === "function" ? window.addEventListener : null,
  };

  // 让页面自己探测"alert 被动过"时至少拿到原生外观（name/length/toString）
  function disguise(fn, name, len) {
    try {
      Object.defineProperty(fn, "name", { value: name, configurable: true });
    } catch (_) {}
    try {
      Object.defineProperty(fn, "length", { value: len, configurable: true });
    } catch (_) {}
    const sig = "function " + name + "() { [native code] }";
    try {
      Object.defineProperty(fn, "toString", {
        value: function () {
          return sig;
        },
        configurable: true,
        writable: true,
      });
    } catch (_) {}
    return fn;
  }

  function callNative(kind, args, fallback) {
    const fn = native[kind];
    if (typeof fn !== "function") return fallback;
    try {
      return fn.apply(window, args);
    } catch (_) {
      return fallback;
    }
  }

  function patchedAlert(message) {
    const msg = clip(message, MAX_MSG);
    const p = policy();
    if (!p.take) return callNative("alert", arguments, undefined);
    push({ kind: "alert", msg, answer: "已关闭", by: why(p) });
    return undefined;
  }

  function patchedConfirm(message) {
    const msg = clip(message, MAX_MSG);
    const p = policy();
    if (!p.take) return callNative("confirm", arguments, false);
    let val;
    let by;
    if (armMatches(p.arm, "confirm")) {
      val = p.arm.accept === true;
      by = "按 AI 预设应答";
      consumeArm();
    } else {
      val = p.confirmAccept === true;
      by = "无人应答，用默认答案";
    }
    push({ kind: "confirm", msg, value: val, answer: val ? "确定" : "取消", by: by + "（" + why(p) + "）" });
    return val;
  }

  function patchedPrompt(message, def) {
    const msg = clip(message, MAX_MSG);
    const p = policy();
    if (!p.take) return callNative("prompt", arguments, null);
    let val;
    let by;
    if (armMatches(p.arm, "prompt")) {
      val = p.arm.text == null ? null : String(p.arm.text);
      by = "按 AI 预设应答";
      consumeArm();
    } else if (p.promptText != null) {
      val = p.promptText;
      by = "无人应答，用默认答案";
    } else {
      val = null; // null = 取消（这是规范里"取消"的返回值）
      by = "无人应答，默认取消";
    }
    push({
      kind: "prompt",
      msg,
      value: val,
      def: def == null ? "" : clip(def, 120),
      answer: val == null ? "取消" : "填入「" + clip(val, 60) + "」",
      by: by + "（" + why(p) + "）",
    });
    return val;
  }

  function why(p) {
    return p.mode === "auto" ? "设置里设为始终接管" : "AI 正在操控本页";
  }

  try {
    window.alert = patchedAlert;
    window.confirm = patchedConfirm;
    window.prompt = patchedPrompt;
    disguise(window.alert, "alert", 1);
    disguise(window.confirm, "confirm", 1);
    disguise(window.prompt, "prompt", 2);
  } catch (_) {}

  // ===== 「离开站点？」确认 =====
  // 页面两种装法都要按住：window.onbeforeunload = fn（绝大多数站点）与 addEventListener。
  // 关键点：接管时**照常调用页面的处理函数**（很多站点在里面自动保存），
  // 但给它一个被"摘了牙"的 event —— preventDefault / returnValue / reason 都不生效，
  // 于是浏览器不会再弹那个框，导航照常走。
  let unloadHandler = null; // 页面通过 window.onbeforeunload 装的处理器

  function neuter(e) {
    try {
      Object.defineProperty(e, "preventDefault", {
        value: function () {},
        configurable: true,
        writable: true,
      });
      Object.defineProperty(e, "returnValue", {
        configurable: true,
        get() {
          return "";
        },
        set() {},
      });
      Object.defineProperty(e, "reason", {
        configurable: true,
        get() {
          return undefined;
        },
        set() {},
      });
    } catch (_) {}
    return e;
  }

  function runUnloadHandler(fn, thisArg, e, kindNote) {
    const p = policy();
    if (!p.take) {
      // 交还浏览器：原样调用，返回值/returnValue 都可能让原生框出现（这正是用户要的）
      try {
        const r = fn.call(thisArg, e);
        if (r != null && r !== "" && kindNote === "attr") {
          try {
            e.returnValue = String(r);
          } catch (_) {}
        }
      } catch (_) {}
      return;
    }
    neuter(e);
    try {
      fn.call(thisArg, e);
    } catch (_) {}
    push({
      kind: "beforeunload",
      msg: kindNote === "attr" ? "页面本想拦住这次离开（window.onbeforeunload）" : "页面本想拦住这次离开（beforeunload 监听）",
      answer: "已放行",
      by: (kindNote === "attr" ? "onbeforeunload " : "addEventListener ") + why(p),
      take: true,
    });
  }

  try {
    Object.defineProperty(window, "onbeforeunload", {
      configurable: true,
      enumerable: true,
      get() {
        return unloadHandler;
      },
      set(v) {
        unloadHandler = typeof v === "function" ? v : null;
      },
    });
  } catch (_) {}

  try {
    const wrapped = new WeakMap(); // 原函数 → 包装函数（removeEventListener 要能对上）
    const wrappedObj = new WeakMap(); // {handleEvent} 对象 → 包装对象
    const add = native.addEL;
    if (add) {
      const patchedAdd = function (type, fn, opts) {
        if (type !== "beforeunload" || !fn) return add.call(this, type, fn, opts);
        if (typeof fn === "function") {
          const w = wrapped.get(fn);
          if (w) return add.call(this, type, w, opts);
          const wrap = function (e) {
            runUnloadHandler(fn, this, e, "listener");
          };
          try {
            Object.defineProperty(wrap, "name", { value: "onbeforeunload", configurable: true });
          } catch (_) {}
          wrapped.set(fn, wrap);
          return add.call(this, type, wrap, opts);
        }
        if (typeof fn === "object" && typeof fn.handleEvent === "function") {
          const cached = wrappedObj.get(fn);
          if (cached) return add.call(this, type, cached, opts);
          const obj = {
            handleEvent(e) {
              runUnloadHandler(fn.handleEvent, fn, e, "listener");
            },
          };
          wrappedObj.set(fn, obj);
          return add.call(this, type, obj, opts);
        }
        return add.call(this, type, fn, opts);
      };
      window.addEventListener = patchedAdd;
      disguise(window.addEventListener, "addEventListener", 2);
      // window.onload/onerror 之类也走 addEventListener(window,...)，但页面里常见的
      // document.addEventListener 不受影响（beforeunload 只在 window 上派发）。

      // 页面上"脏表单"这类库会先 add 再 remove 这个监听。我们登记的是包装函数，
      // 所以 remove 也要按同一张表翻译一次 —— 否则摘不掉：页面都说不拦了，还替它拦住离开。
      const nativeRem = typeof window.removeEventListener === "function" ? window.removeEventListener : null;
      if (nativeRem) {
        window.removeEventListener = function (type, fn, opts) {
          if (type === "beforeunload" && fn && (typeof fn === "function" || typeof fn === "object")) {
            const w = wrapped.get(fn) || wrappedObj.get(fn);
            if (w) return nativeRem.call(this, type, w, opts);
          }
          return nativeRem.apply(this, arguments);
        };
        disguise(window.removeEventListener, "removeEventListener", 2);
      }
    }
    // 我们自己始终挂一个真实的监听，负责调用被我们"扣下"的 onbeforeunload
    if (add) {
      add.call(window, "beforeunload", (e) => {
        if (!unloadHandler) return;
        runUnloadHandler(unloadHandler, window, e, "attr");
      });
    }
  } catch (_) {}

  // 供页面调试/自检用（只在页面世界里可见，隔离世界读不到 —— 侧栏走 DOM 属性）
  try {
    Object.defineProperty(window, "__qnDialog", {
      value: {
        list: () => readLog().items,
        clear: () => {
          const st = readLog();
          st.items = [];
          setAttr(LOG, JSON.stringify(st));
        },
        policy: () => {
          const p = policy();
          return { mode: p.mode, take: p.take, aiOn: p.aiOn };
        },
      },
      configurable: true,
    });
  } catch (_) {}

  // 报告"钩子到底装上没有"：极少数页面会在我们之前自己改写 alert，或某个 defineProperty 失败，
  // 那样这页的弹窗其实没被接管。侧栏据此如实告诉 AI，而不是让它以为弹窗已被自己答掉。
  setAttr(
    ENV,
    JSON.stringify({
      hook: 1,
      alert: window.alert === patchedAlert,
      confirm: window.confirm === patchedConfirm,
      prompt: window.prompt === patchedPrompt,
      unload: window.addEventListener !== native.addEL,
    })
  );
})();
