// 弹窗接管桥（ISOLATED world · document_start · 所有框架）
//
// 只做两件很窄的事，别把逻辑塞进来：
//   ① 把用户设置里的「弹窗接管」三项抄进 data-qn-dlg-cfg
//      —— 钩子在页面世界里，读不到 chrome.storage，只能靠这个共享的 DOM 属性；
//      每次设置变动都重写，所以改完设置**不用刷新页面**就生效。
//   ② 盯着 data-qn-dlg-log 的变化，把新产生的弹窗事件转告 service worker
//      —— 侧栏据此即时提示"页面刚弹了个 alert，已替你关掉"，
//      以及在 AI 正忙时把这条信息并进下一步动作结果。
// （账本本身在 DOM 属性上，control.js 随时能整本读走，所以这里只做"即时播报"。）
(() => {
  if (window.__qnDialogBridge) return;
  window.__qnDialogBridge = true;

  const CFG = "data-qn-dlg-cfg";
  const LOG = "data-qn-dlg-log";
  const LIVE = "data-qn-dlg-live";
  const SETTING_KEY = "ai_browser_settings";

  let cfg = { mode: "ai", confirmAccept: false, promptText: "" };
  let lastSeq = 0;
  let mo = null;

  const root = () => document.documentElement || document;

  function pick(s) {
    const mode = s && (s.dialogMode === "auto" || s.dialogMode === "off") ? s.dialogMode : "ai";
    const text = s && typeof s.dialogPromptText === "string" ? s.dialogPromptText.slice(0, 200) : "";
    cfg = {
      mode,
      confirmAccept: !!(s && s.dialogConfirmAccept === true),
      promptText: text,
    };
  }

  function write() {
    const el = root();
    try {
      el.setAttribute(CFG, JSON.stringify(cfg));
    } catch (_) {}
  }

  function readJsonAttr(name) {
    const el = root();
    try {
      const o = JSON.parse((el && el.getAttribute ? el.getAttribute(name) : null) || "{}");
      return o && typeof o === "object" ? o : {};
    } catch (_) {
      return {};
    }
  }

  function load() {
    try {
      const p = chrome.storage.local.get(SETTING_KEY);
      const done = (got) => {
        pick(got && got[SETTING_KEY]);
        write();
      };
      if (p && p.then) p.then(done, () => write());
      else done(p); // 老实现兜底
    } catch (_) {
      write();
    }
  }

  function relay() {
    const st = readJsonAttr(LOG);
    const items = Array.isArray(st.items) ? st.items : [];
    const seq = Number(st.seq) || 0;
    if (seq <= lastSeq) return;
    const fresh = items.filter((it) => it && Number(it.seq) > lastSeq);
    lastSeq = seq;
    for (const ev of fresh) {
      try {
        const p = chrome.runtime.sendMessage({ type: "dialog:event", ev });
        if (p && p.catch) p.catch(() => {});
      } catch (_) {
        // 扩展刚被重载：这条通道已经作废，别再盯着了
        try {
          if (mo) mo.disconnect();
        } catch (__) {}
        return;
      }
    }
  }

  // ===== 心跳（AI 在不在操控这一页）=====
  // 为什么要桥来写：control.js 只注入得到顶层框架，可**跨域 iframe 里的 alert 一样会把整页按住**。
  // 侧栏每开始/结束一步就给这一页的**所有框架**发一声，由这里落到本框架的 data-qn-dlg-live。
  //
  // ⚠️ 窗口**只延长、绝不剪短**（单调）：顶层框架里 control.js 也在写这本心跳（它知道后台任务
  // 要等多久，可能一写就是 10 分钟），而桥这一声通常只带 60~90 秒 —— 照写就会把更长的窗口剪短，
  // 于是"自动执行 + 模型思考/重试超过 90 秒"这种情况下接管提前失效，页面弹出的框变回原生、
  // 把整页按住，而这一轮根本没人等着替你点（用户报的就是这个毛病）。
  function bumpLive(ttl) {
    const el = root();
    let live = {};
    try {
      live = JSON.parse((el && el.getAttribute ? el.getAttribute(LIVE) : null) || "{}") || {};
    } catch (_) {}
    const now = Date.now();
    const cap = (n) => Math.min(600000, Math.max(0, Number(n) || 0));
    const remaining =
      Number(live.ai) === 1 ? Math.max(0, (Number(live.at) || 0) + cap(live.ttl) - now) : 0;
    const want = Math.min(600000, Math.max(15000, Number(ttl) || 90000));
    live.ai = 1;
    live.at = now;
    live.ttl = Math.max(remaining, want);
    try {
      el.setAttribute(LIVE, JSON.stringify(live));
    } catch (_) {}
  }

  function idleLive() {
    // "这一轮干完了"：至少留 20 秒收尾窗口（点完一秒后才弹出的「保存成功」属于这一步的尾巴）。
    // 同样只延长不剪短 —— 后台任务还挂着等弹窗的话，那个长窗口必须留着。
    bumpLive(20000);
  }

  try {
    chrome.runtime.onMessage.addListener((msg) => {
      if (!msg || typeof msg !== "object") return;
      if (msg.type === "dialog:beat") bumpLive(msg.ttl);
      else if (msg.type === "dialog:idle") idleLive();
    });
  } catch (_) {}

  function attach() {
    write();
    load();
    lastSeq = Number(readJsonAttr(LOG).seq) || 0;
    try {
      mo = new MutationObserver(() => relay());
      mo.observe(root(), { attributes: true, attributeFilter: [LOG] });
    } catch (_) {}
    try {
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== "local" || !changes || !changes[SETTING_KEY]) return;
        pick(changes[SETTING_KEY].newValue);
        write();
      });
    } catch (_) {}
  }

  if (document.documentElement) attach();
  else document.addEventListener("readystatechange", attach, { once: true });
})();
