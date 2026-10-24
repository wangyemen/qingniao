// 页面控制脚本：可交互元素索引快照 + 动作执行
// 由 sidepanel 按需通过 chrome.scripting 注入；幂等安装。
(() => {
  if (globalThis.__aiCtl) return;

  const INTERACTIVE_SEL = [
    "a[href]",
    "button",
    "input:not([type=hidden])",
    "select",
    "textarea",
    "summary",
    '[role="button"]',
    '[role="link"]',
    '[role="checkbox"]',
    '[role="radio"]',
    '[role="switch"]',
    '[role="tab"]',
    '[role="menuitem"]',
    '[role="option"]',
    '[role="textbox"]',
    // 富文本编辑器：contenteditable 的取值形式很多（true / 空 / plaintext-only），
    // 只认 "true" 会漏掉一大半编辑器（ProseMirror / Quill / Lexical / Slate 等）
    '[contenteditable="true"]',
    '[contenteditable=""]',
    '[contenteditable]:not([contenteditable="false"])',
  ].join(",");

  const MAX_ELEMENTS = 80;
  const MAX_DEPTH = 6; // shadow DOM / iframe 递归深度

  function norm(s) {
    return String(s || "")
      .replace(/\s+/g, " ")
      .trim();
  }

  function clip(s, n) {
    s = norm(s);
    return s.length > n ? s.slice(0, n) + "…" : s;
  }

  function isVisible(el) {
    if (!el || !el.isConnected) return false;
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    const st = getComputedStyle(el);
    if (st.visibility === "hidden" || st.display === "none" || st.opacity === "0") {
      return false;
    }
    return true;
  }

  // 是否在当前视口内：元素太多要取舍时，视口内的和输入框优先保留
  function inViewport(el) {
    try {
      const r = el.getBoundingClientRect();
      const vh = window.innerHeight || 800;
      const vw = window.innerWidth || 600;
      return r.bottom > 0 && r.right > 0 && r.top < vh && r.left < vw;
    } catch (_) {
      return false;
    }
  }

  // ===== 勾选项（复选框/单选框/开关）判定 =====
  // 现代站点的勾选框五花八门：原生 input、div[role=checkbox]、aria-checked、
  // 藏在 label 里用 CSS 画出来的透明 input、甚至只用 class 表达状态的小方块……必须都认。
  function isToggleLike(el) {
    if (!el) return false;
    const tag = el.tagName ? el.tagName.toLowerCase() : "";
    if (tag === "input") {
      const t = (el.type || "text").toLowerCase();
      return t === "checkbox" || t === "radio";
    }
    const role = (el.getAttribute && el.getAttribute("role")) || "";
    if (["checkbox", "radio", "switch"].includes(role)) return true;
    if (el.getAttribute && el.getAttribute("aria-checked") != null) return true;
    // 完全自绘的小方块（没有 input / role / aria）
    if (isFakeCheckbox(el)) return true;
    return false;
  }

  // 读取勾选状态：true / false / null（未知）
  function readToggleState(el) {
    if (!el) return null;
    const tag = el.tagName ? el.tagName.toLowerCase() : "";
    if (tag === "input") {
      const t = (el.type || "").toLowerCase();
      if (t === "checkbox" || t === "radio") return !!el.checked;
      return null;
    }
    const aria = el.getAttribute && el.getAttribute("aria-checked");
    if (aria === "true") return true;
    if (aria === "false") return false;
    const ds = el.getAttribute && el.getAttribute("data-checked");
    if (ds === "true") return true;
    if (ds === "false") return false;
    // 组件库常用 class 表达状态
    const cls = (el.className && el.className.baseVal !== undefined ? el.className.baseVal : el.className) || "";
    if (typeof cls === "string" && cls) {
      if (/(^|[\s_-])(is-)?checked([\s_-]|$)/.test(cls)) return true;
      if (/(^|[\s_-])(is-)?unchecked([\s_-]|$)/.test(cls)) return false;
      if (/(^|[\s_-])(is-)?active([\s_-]|$)/.test(cls)) return true;
    }
    return null;
  }

  // 控件的"规范代表"：自绘勾选框内部真正的原生 input 才是权威状态源
  // （元素列表去重时用它，避免同一个勾选框出现两次）
  function canonicalToggle(el) {
    if (!el) return null;
    const tag = el.tagName ? el.tagName.toLowerCase() : "";
    if (tag === "input") {
      const t = (el.type || "").toLowerCase();
      return t === "checkbox" || t === "radio" ? el : null;
    }
    const role = (el.getAttribute && el.getAttribute("role")) || "";
    const aria = el.getAttribute && el.getAttribute("aria-checked");
    if (["checkbox", "radio", "switch"].includes(role) || aria != null) {
      const inner = el.querySelector && el.querySelector('input[type="checkbox"],input[type="radio"]');
      return inner || null;
    }
    if (tag === "label") {
      const t = labelTarget(el);
      if (t) return t;
    }
    return null;
  }

  // label[for] 或 label 内部关联的原生 input
  function labelTarget(lab) {
    if (!lab) return null;
    const doc = lab.ownerDocument || document;
    const f = lab.getAttribute && lab.getAttribute("for");
    if (f) {
      try {
        const t = doc.getElementById(f);
        if (t) {
          const tt = (t.type || "").toLowerCase();
          if (tt === "checkbox" || tt === "radio") return t;
        }
      } catch (_) {}
    }
    try {
      const inner = lab.querySelector && lab.querySelector('input[type="checkbox"],input[type="radio"]');
      if (inner) return inner;
    } catch (_) {}
    return null;
  }

  // 隐藏的勾选框（自绘样式常见：input 透明/display:none，旁边画个方块）
  // 本身不可见，但只要它有一个可见的"代理"（label / 父容器）就仍然要暴露给模型
  function hasVisibleProxy(el) {
    try {
      const lab = el.closest && el.closest("label");
      if (lab && isVisible(lab)) return true;
      if (el.id) {
        const doc = el.ownerDocument || document;
        const l2 = doc.querySelector(`label[for="${CSS.escape(el.id)}"]`);
        if (l2 && isVisible(l2)) return true;
      }
      const p = el.parentElement;
      if (p && isVisible(p)) return true;
    } catch (_) {}
    return false;
  }

  function isHiddenToggleUsable(el) {
    if (!isToggleLike(el)) return false;
    if (!el.isConnected) return false;
    return hasVisibleProxy(el);
  }

  // 明确的"非勾选类原生控件"：按钮 / 链接 / 文本框 / 下拉 / 提交按钮……
  // 它们本身不可能有 checked 语义。模型把 check 动作打到这类元素上时必须如实报错，
  // 绝不能"顺藤摸瓜"把父容器里恰好存在的复选框当成目标 ——
  // 否则对"提交"按钮执行 check 会返回"已处于勾选状态"，
  // 模型就会据此写下"提交按钮已处于勾选状态"（用户反馈的真实 bug）。
  const NON_TOGGLE_ROLES = [
    "button", "link", "tab", "menuitem", "option", "textbox",
    "searchbox", "combobox", "listbox",
  ];
  function isDefinitelyNotToggle(el) {
    if (!el) return false;
    const tag = el.tagName ? el.tagName.toLowerCase() : "";
    if (tag === "input") {
      const t = (el.type || "text").toLowerCase();
      return t !== "checkbox" && t !== "radio";
    }
    if (["button", "a", "select", "textarea", "summary"].includes(tag)) return true;
    const role = (el.getAttribute && el.getAttribute("role")) || "";
    return NON_TOGGLE_ROLES.includes(role);
  }

  // 勾选动作的"权威目标"：可能是原生 input，也可能是 role/aria 勾选框
  function resolveToggle(el) {
    if (!el) return null;
    const tag = el.tagName ? el.tagName.toLowerCase() : "";
    if (tag === "input") {
      const t = (el.type || "").toLowerCase();
      if (t === "checkbox" || t === "radio") {
        return { el, kind: t, state: () => !!el.checked };
      }
      return null;
    }
    const role = (el.getAttribute && el.getAttribute("role")) || "";
    const aria = el.getAttribute && el.getAttribute("aria-checked");
    if (["checkbox", "radio", "switch"].includes(role) || aria != null) {
      const inner = el.querySelector && el.querySelector('input[type="checkbox"],input[type="radio"]');
      if (inner) {
        return { el: inner, kind: (inner.type || "checkbox").toLowerCase(), state: () => !!inner.checked, proxy: el };
      }
      return { el, kind: role || "switch", state: () => readToggleState(el) };
    }
    if (tag === "label") {
      const t = labelTarget(el);
      if (t) return { el: t, kind: (t.type || "checkbox").toLowerCase(), state: () => !!t.checked, proxy: el };
      return null;
    }
    // 明确的非勾选控件（按钮 / 链接 / 输入框 / 提交按钮…）直接判定失败，不做任何兜底。
    // 这一步是必须的：否则对"提交"按钮执行 check 时，会顺着"父容器里唯一的那个勾选框"
    // 兜底摸到旁边无关的复选框，返回"已处于勾选状态"，让模型误以为提交按钮被勾选了。
    if (isDefinitelyNotToggle(el)) return null;
    // 模型点到了按钮内部的文字/图标时同理：真正的控件是那个按钮，不是旁边的复选框。
    // 只对"按钮 / 链接 / 非勾选类 input"这几个明确会抢走点击的祖先生效，
    // label 之类的代理容器不在此列（它们本来就是勾选框的合法代理）。
    const up = nearestActionable(el);
    if (up && up !== el) {
      const upTag = up.tagName ? up.tagName.toLowerCase() : "";
      const upType = ((up.getAttribute && up.getAttribute("type")) || "").toLowerCase();
      if (upTag === "button" || upTag === "a" || (upTag === "input" && upType !== "checkbox" && upType !== "radio")) {
        return null;
      }
    }
    // 兜底 1：元素内部就有原生 input
    try {
      const inner = el.querySelector && el.querySelector('input[type="checkbox"],input[type="radio"]');
      if (inner) {
        return { el: inner, kind: (inner.type || "checkbox").toLowerCase(), state: () => !!inner.checked, proxy: el };
      }
    } catch (_) {}
    // 兜底 2：父容器里唯一的那个勾选框（模型点到了旁边的文字/图标）
    try {
      const p = el.parentElement;
      if (p) {
        const cands = Array.from(p.querySelectorAll('input[type="checkbox"],input[type="radio"]'));
        if (cands.length === 1) {
          return { el: cands[0], kind: (cands[0].type || "checkbox").toLowerCase(), state: () => !!cands[0].checked, proxy: el };
        }
      }
    } catch (_) {}
    // 兜底 3：完全自绘的方块（只有 class 表达状态，没有 input/role/aria）
    if (isFakeCheckbox(el)) {
      return { el, kind: "checkbox", state: () => readToggleState(el), proxy: el };
    }
    return null;
  }

  // 在容器里找一个"自绘勾选框外壳"（带 checked 语义的小方块）
  function findToggleShell(root) {
    if (!root) return null;
    try {
      const cands = root.querySelectorAll(
        '[role="checkbox"], [role="switch"], [aria-checked], [class*="check" i], [class*="checkbox" i]'
      );
      for (const c of cands) {
        if (c === root) continue;
        if (!isVisible(c)) continue;
        const r = c.getBoundingClientRect();
        if (r.width > 90 || r.height > 90) continue;
        return c;
      }
    } catch (_) {}
    return null;
  }

  // 给自绘方块找对应的原生 input：
  // ① 自己内部的 ② 父容器里唯一的那个 ③ 相邻的
  function relatedToggleInput(el) {
    if (!el) return null;
    try {
      const own = el.querySelector && el.querySelector('input[type="checkbox"],input[type="radio"]');
      if (own) return own;
      const p = el.parentElement;
      if (p) {
        const cands = Array.from(p.querySelectorAll('input[type="checkbox"],input[type="radio"]'));
        if (cands.length === 1) return cands[0];
        // 紧邻的（同一个 label 里）
        const lab = p.closest && p.closest("label");
        if (lab) {
          const t = labelTarget(lab);
          if (t) return t;
        }
      }
    } catch (_) {}
    return null;
  }

  // 找到"文字元素"旁边的勾选框：
  // ① 同父容器里的勾选框  ② label 关联的  ③ 前后兄弟里的
  function findNearbyToggle(textEl) {
    if (!textEl) return null;
    try {
      // ① 同一个 label 里
      const lab = textEl.closest && textEl.closest("label");
      if (lab) {
        const t = labelTarget(lab);
        if (t) return t;
        for (const child of lab.children) {
          if (isFakeCheckbox(child) || isToggleLike(child)) return child;
        }
      }
      // ② 前后紧邻的兄弟（最多看 2 个）
      let sib = textEl.previousElementSibling;
      for (let k = 0; k < 2 && sib; k++, sib = sib.previousElementSibling) {
        if (isToggleLike(sib)) return sib;
        const inner = sib.querySelector && sib.querySelector('input[type="checkbox"],input[type="radio"]');
        if (inner) return inner;
        for (const child of sib.children) {
          if (isFakeCheckbox(child) || isToggleLike(child)) return child;
        }
      }
      sib = textEl.nextElementSibling;
      for (let k = 0; k < 2 && sib; k++, sib = sib.nextElementSibling) {
        if (isToggleLike(sib)) return sib;
        const inner = sib.querySelector && sib.querySelector('input[type="checkbox"],input[type="radio"]');
        if (inner) return inner;
        for (const child of sib.children) {
          if (isFakeCheckbox(child) || isToggleLike(child)) return child;
        }
      }
      // ③ 父容器里唯一的那个勾选框（父容器必须"小"——不能是整个回复区）
      const p = textEl.parentElement;
      if (p) {
        const cands = Array.from(p.querySelectorAll('input[type="checkbox"],input[type="radio"]'));
        if (cands.length === 1) {
          const t = norm(p.innerText || p.textContent || "");
          if (t && t.length <= 30) return cands[0];
        }
        for (const child of p.children) {
          if (isFakeCheckbox(child) || isToggleLike(child)) return child;
        }
      }
    } catch (_) {}
    return null;
  }

  // 可操作元素：能点/能填/能勾的那些（用于 find 时排除纯容器）
  function isActionable(el) {
    if (!el) return false;
    const tag = el.tagName ? el.tagName.toLowerCase() : "";
    if (["a", "button", "input", "select", "textarea", "summary", "label"].includes(tag)) return true;
    const role = (el.getAttribute && el.getAttribute("role")) || "";
    if (["button", "link", "checkbox", "radio", "switch", "tab", "menuitem", "option", "textbox"].includes(role)) {
      return true;
    }
    if (isEditable(el) || isRichText(el)) return true;
    return false;
  }

  // 自绘勾选框（没有真实 input，靠 CSS 画方块）：两类特征
  // ① class/id 里带 check/checkbox 之类  ② 是个"小方块"且旁边有短文字
  const FAKE_CB_RE = /check|checkbox|icon-?tick|icon-?ok/i;
  // 纯装饰性标签：图标/图片不可能自己是勾选框（按钮里的 svg 常被误判成 16×16 小方块）
  const DECORATIVE_TAGS = ["svg", "path", "use", "g", "circle", "rect", "line", "polyline", "polygon", "img", "picture", "canvas"];

  // 元素是否"住在某个控件内部"（按钮/链接/输入框/label 里的图标、文字、装饰块）。
  // 这类元素是控件的组成部分，不是独立控件 —— 不能把它们当成勾选框，
  // 否则"提交"按钮里的图标会被当成勾选框，按钮文字被当标签，最终报出
  // "提交按钮已处于勾选状态"这种结论。
  function insideControl(el) {
    let node = el && el.parentElement;
    for (let d = 0; d < 4 && node; d++) {
      const tag = node.tagName ? node.tagName.toLowerCase() : "";
      if (["button", "a", "input", "select", "textarea", "summary", "label"].includes(tag)) return true;
      const role = (node.getAttribute && node.getAttribute("role")) || "";
      if (["button", "link", "checkbox", "radio", "switch", "tab", "menuitem", "option", "textbox"].includes(role)) {
        return true;
      }
      node = node.parentElement;
    }
    return false;
  }

  function isFakeCheckbox(el) {
    if (!el) return false;
    const tag = el.tagName ? el.tagName.toLowerCase() : "";
    if (["input", "select", "textarea", "a", "button"].includes(tag)) return false;
    if (DECORATIVE_TAGS.includes(tag)) return false;
    if (el.getAttribute && el.getAttribute("role")) return false; // role 的走正规路径
    // 控件内部的图标/装饰块：属于那个控件，不是独立勾选框
    if (insideControl(el)) return false;
    const cls = (el.className && el.className.baseVal !== undefined ? el.className.baseVal : el.className) || "";
    const s = typeof cls === "string" ? cls : "";
    if (FAKE_CB_RE.test(s) || FAKE_CB_RE.test(el.id || "")) {
      const r = el.getBoundingClientRect();
      if (r.width < 6 || r.height < 6) return false;
      if (r.width > 90 || r.height > 90) return false; // 整行容器不算
      return true;
    }
    // 小方块（10~34px、近似正方形）且旁边/父级有短文字 → 也是自绘勾选框
    const r = el.getBoundingClientRect();
    if (r.width < 8 || r.height < 8) return false;
    if (r.width > 34 || r.height > 34) return false;
    if (Math.abs(r.width - r.height) > 10) return false;
    // 自身不能有文字
    if (norm(el.innerText || el.textContent || "")) return false;
    // 附近要有短文字（这是它"作为一个选项"的证据）
    let node = el.parentElement;
    for (let d = 0; d < 3 && node; d++) {
      const t = norm(node.innerText || node.textContent || "");
      if (t && t.length <= 30) return true;
      if (node.tagName && node.tagName.toLowerCase() === "label") return true;
      node = node.parentElement;
    }
    return false;
  }

  // 元素"自己的"可搜索文本：不含从兄弟/祖先节点借来的旁注文字。
  // 为什么要单独算：勾选框的 label 常常是旁边的文字（"匿名发表"），find 必须能找到它；
  // 但反过来，"提交"按钮旁边的复选框也会借到"提交"这两个字，
  // 于是 find "提交" 会同时命中按钮和那个复选框，模型就把复选框当成提交按钮了。
  // 所以匹配时分两层：先只用"自身文字"找，找不到再退回"旁注文字"。
  function directSearchText(el) {
    const parts = [];
    try {
      const l = labelOf(el);
      if (l) parts.push(l);
      const t = el.innerText || el.textContent || "";
      if (t) parts.push(t);
      for (const a of ["aria-label", "placeholder", "title", "alt", "name", "value", "type"]) {
        const v = el.getAttribute && el.getAttribute(a);
        if (v) parts.push(v);
      }
    } catch (_) {}
    return norm(parts.join(" ")).toLowerCase();
  }

  // 元素的可搜索文本：给 find 动作和 label 兜底用
  function searchText(el) {
    const parts = [];
    try {
      const l = labelOf(el);
      if (l) parts.push(l);
      const t = el.innerText || el.textContent || "";
      if (t) parts.push(t);
      for (const a of ["aria-label", "placeholder", "title", "alt", "name", "value", "type"]) {
        const v = el.getAttribute && el.getAttribute(a);
        if (v) parts.push(v);
      }
      // 自绘勾选框的文案在兄弟/父节点上，勾选框本身没文字 —— 必须一起算进去，
      // 否则 find 搜"匿名发表"就找不到那个勾选框
      // 注意：勾选框只取"自己的标签"，不能把整块容器的文字算进来
      //（否则搜"开启提醒"会把同一区域的其它勾选框也匹配上）
      if (isToggleLike(el)) {
        const tl = toggleLabel(el);
        if (tl) parts.push(tl);
        // 勾选框自身的文字（不含祖先容器文字）
        const ownTxt = norm(el.innerText || el.textContent || "");
        if (ownTxt) parts.push(ownTxt);
        return norm(parts.join(" ")).toLowerCase();
      }
    } catch (_) {}
    return norm(parts.join(" ")).toLowerCase();
  }

  // 富文本编辑器判定：contenteditable 或 role=textbox 的可编辑区域
  function isRichText(el) {
    if (!el) return false;
    if (el.isContentEditable) return true;
    const ce = el.getAttribute && el.getAttribute("contenteditable");
    if (ce != null && ce !== "false") return true;
    if (el.getAttribute && el.getAttribute("role") === "textbox") return true;
    return false;
  }

  // 可输入判定：普通文本框 + 富文本区域
  function isEditable(el) {
    if (!el) return false;
    if (isRichText(el)) return true;
    const tag = el.tagName ? el.tagName.toLowerCase() : "";
    if (tag === "textarea") return true;
    if (tag === "input") {
      // 只把"能写字"的 input 算可输入，按钮/勾选/文件/日期等不算
      const t = (el.type || "text").toLowerCase();
      return ![
        "button",
        "submit",
        "reset",
        "image",
        "radio",
        "checkbox",
        "file",
        "hidden",
        "range",
        "color",
        "date",
        "datetime-local",
        "month",
        "time",
        "week",
      ].includes(t);
    }
    return false;
  }

  // 常见的富文本编辑器容器（用于补充 label，模型才知道"这是正文编辑器"）
  const RICH_HINTS = [
    ["ql-editor", "Quill 富文本编辑器"],
    ["ProseMirror", "ProseMirror 富文本编辑器"],
    ["slate-editor", "Slate 富文本编辑器"],
    ["lexical", "Lexical 富文本编辑器"],
    ["monaco-editor", "代码编辑器"],
    ["CodeMirror", "代码编辑器"],
    ["trix-content", "Trix 富文本编辑器"],
    ["ck-content", "CKEditor 富文本编辑器"],
    ["mce-content-body", "TinyMCE 富文本编辑器"],
    ["tox-edit-area", "TinyMCE 富文本编辑器"],
  ];

  function richHint(el) {
    const cls = (el.className && el.className.baseVal !== undefined ? el.className.baseVal : el.className) || "";
    const s = typeof cls === "string" ? cls : "";
    if (!s) return "";
    for (const [key, name] of RICH_HINTS) {
      if (s.includes(key)) return name;
    }
    return "";
  }

  // 无障碍角色：优先用显式 role 属性，否则按标签/类型推断。
  // 模型看到 "role=button" 才知道这是个可点的按钮，而不是靠标签文字猜。
  function axRole(el) {
    if (!el) return "";
    const explicit = el.getAttribute && el.getAttribute("role");
    if (explicit) return explicit.trim().split(/\s+/)[0];
    const tag = el.tagName ? el.tagName.toLowerCase() : "";
    const type = (el.type || "").toLowerCase();
    switch (tag) {
      case "button":
        return "button";
      case "a":
        return el.hasAttribute("href") ? "link" : "";
      case "input":
        if (type === "checkbox") return "checkbox";
        if (type === "radio") return "radio";
        if (type === "submit" || type === "button" || type === "reset" || type === "image") return "button";
        if (type === "range") return "slider";
        if (type === "number") return "spinbutton";
        if (type === "search") return "searchbox";
        if (type === "file") return "button";
        if (type === "hidden") return "";
        return "textbox";
      case "textarea":
        return "textbox";
      case "select":
        return el.multiple || (el.size || 0) > 1 ? "listbox" : "combobox";
      case "img":
        return el.getAttribute("alt") === "" ? "presentation" : "img";
      case "summary":
        return "button";
      case "h1":
      case "h2":
      case "h3":
      case "h4":
      case "h5":
      case "h6":
        return "heading";
      case "ul":
      case "ol":
        return "list";
      case "li":
        return "listitem";
      case "table":
        return "table";
      case "nav":
        return "navigation";
      case "main":
        return "main";
      case "header":
        return "banner";
      case "footer":
        return "contentinfo";
      case "aside":
        return "complementary";
      case "form":
        return "form";
      case "dialog":
        return "dialog";
      case "label":
        return "label";
      case "option":
        return "option";
      case "progress":
        return "progressbar";
      case "hr":
        return "separator";
      default:
        break;
    }
    if (isRichText(el)) return "textbox";
    if (isFakeCheckbox(el)) return "checkbox";
    return "";
  }

  // 按 W3C accname 算法的优先级顺序算「可访问名称」。
  // 为什么必须算准：模型只能靠名称判断"哪个是那个按钮"——名称算不出来，
  // 模型就只能靠编号瞎猜（用户反馈"AI 在猜按钮"）。
  // 优先级：aria-labelledby > aria-label > 原生 label > 内容 > title > placeholder > alt
  function labelOf(el) {
    if (!el) return "";

    // 1. aria-labelledby：指向页面上别的元素当名字（图标按钮最常用这招）
    const lb = el.getAttribute && el.getAttribute("aria-labelledby");
    if (lb) {
      const parts = [];
      for (const id of lb.split(/\s+/)) {
        if (!id) continue;
        const ref =
          (el.ownerDocument || document).getElementById(id) ||
          (el.getRootNode && el.getRootNode().querySelector
            ? el.getRootNode().querySelector(`#${CSS.escape(id)}`)
            : null);
        if (ref) {
          const t = norm(ref.innerText || ref.textContent || ref.getAttribute?.("aria-label") || "");
          if (t) parts.push(t);
        }
      }
      if (parts.length) return clip(parts.join(" "), 40);
    }

    // 2. aria-label
    const aria = el.getAttribute && el.getAttribute("aria-label");
    if (aria && norm(aria)) return clip(aria, 40);

    // 3. 原生 label（label[for] / 祖先 label）
    if (el.id) {
      try {
        const doc = el.ownerDocument || document;
        const lab = doc.querySelector(`label[for="${CSS.escape(el.id)}"]`);
        if (lab) {
          const t = norm(lab.innerText || lab.textContent);
          if (t) return clip(t, 40);
        }
      } catch (_) {}
    }
    const wrap = el.closest && el.closest("label");
    if (wrap) {
      const t = norm(wrap.innerText || wrap.textContent);
      if (t) return clip(t, 40);
    }

    // 4. 自身内容（按钮/链接的文字）
    const own = norm(el.innerText || el.textContent || "");
    if (own) return clip(own, 40);

    // 5. title 属性（图标按钮常写在这里）
    const title = el.getAttribute && el.getAttribute("title");
    if (title && norm(title)) return clip(title, 40);

    // 6. 图标按钮的隐藏文字：<button><svg><title>搜索</title></svg></button>
    //    或 <button><img alt="搜索"></button> —— 这些名字肉眼看不见，但屏幕阅读器能读，
    //    模型看不到就等于没有 → 这正是"猜按钮"的高发区
    const inner = innerName(el);
    if (inner) return clip(inner, 40);

    // 7. 输入框类的占位提示
    const ph = el.getAttribute && el.getAttribute("placeholder");
    if (ph) return clip(ph, 40);
    // 富文本编辑器的占位提示常放在 aria-placeholder / data-placeholder（ProseMirror、Lexical）
    const aph = el.getAttribute && el.getAttribute("aria-placeholder");
    if (aph) return clip(aph, 40);
    const dph = el.getAttribute && el.getAttribute("data-placeholder");
    if (dph) return clip(dph, 40);
    // Quill 的占位是一个独立元素
    try {
      const holder = el.parentElement && el.parentElement.querySelector(".ql-placeholder");
      if (holder) return clip(holder.innerText || holder.textContent, 40);
    } catch (_) {}

    // 8. alt / value / name
    const alt = el.getAttribute && el.getAttribute("alt");
    if (alt && norm(alt)) return clip(alt, 40);
    if (el.type === "submit" || el.type === "button") {
      const v = norm(el.value);
      if (v) return clip(v, 40);
    }
    if (el.name && norm(el.name)) return clip(el.name, 40);

    const hint = richHint(el);
    if (hint) return hint;
    if (isRichText(el)) return "富文本编辑器（可输入）";
    return "";
  }

  // 元素内部的隐藏文字：<svg><title>、<img alt>、图标字体按钮的 aria-label
  // 这些是"看不见但有名字"的地方，模型在元素列表里看不到，必须由我们算出来
  function innerName(el) {
    try {
      const svgTitle = el.querySelector && el.querySelector("svg title, title");
      if (svgTitle) {
        const t = norm(svgTitle.textContent);
        if (t) return t;
      }
      const img = el.querySelector && el.querySelector("img[alt]");
      if (img) {
        const t = norm(img.getAttribute("alt"));
        // alt="" 是"装饰性图片"，不是名字
        if (t) return t;
      }
      // 图标字体按钮：<i class="iconfont icon-search"></i> 本身没名字，
      // 但外层按钮常有 data-* / class 提示，用它们兜底
      const icon = el.querySelector && el.querySelector("[class*='icon']");
      if (icon) {
        const cls = (icon.className && icon.className.baseVal !== undefined ? icon.className.baseVal : icon.className) || "";
        const s = typeof cls === "string" ? cls : "";
        // 从 icon-search / icon-sousuo 里抽出 "search" 这种有语义的词
        const m = /icon[-_]([a-z0-9\u4e00-\u9fa5]{2,20})/i.exec(s);
        if (m) return `图标：${m[1]}`;
      }
    } catch (_) {}
    return "";
  }

  // ===== 无障碍树（a11y）=====
  // 为什么需要：元素列表是"扁平编号 + 截断"，页面上按钮一多，模型只能靠编号猜
  // （用户反馈"AI 在猜按钮"）。无障碍树给出的是「角色 + 名称 + 状态」的层级结构，
  // 模型可以像读屏幕阅读器一样读页面，按名字定位，而不是猜。
  // 为什么自己算而不用 CDP Accessibility.getFullAXTree：
  //   ① CDP 要 chrome.debugger 权限，会挂"正在调试此浏览器"黄条（用户明确在意这个代价）
  //   ② 自己算能和我们的元素编号体系对齐（树里的节点直接带可操作编号）

  // 树里只保留"有语义"的节点，避免输出几百行 div
  const A11Y_INTERESTING = new Set([
    "button", "link", "textbox", "searchbox", "checkbox", "radio", "combobox",
    "listbox", "option", "tab", "menuitem", "switch", "slider", "spinbutton",
    "heading", "navigation", "main", "banner", "contentinfo", "complementary",
    "form", "dialog", "list", "listitem", "table", "img", "label", "separator",
    "progressbar", "status", "alert", "toolbar", "region", "group", "article",
  ]);

  // 把一个元素渲染成树的一行：角色「名称」+ 状态 + 可操作编号
  function a11yNode(el, depth, opts) {
    const role = axRole(el);
    if (!role) return null;
    const name = labelOf(el);
    const bits = [];
    bits.push(role);
    if (name) bits.push(`「${clip(name, 30)}」`);
    // 状态：让模型知道这个按钮是"已勾选"还是"已禁用"，别去点不能点的
    const st = [];
    if (isToggleLike(el)) {
      const s = readToggleState(el);
      if (s === true) st.push("已勾选");
      else if (s === false) st.push("未勾选");
    }
    if (el.disabled || el.getAttribute("aria-disabled") === "true") st.push("禁用");
    const exp = el.getAttribute("aria-expanded");
    if (exp === "true") st.push("已展开");
    else if (exp === "false") st.push("已折叠");
    const sel = el.getAttribute("aria-selected");
    if (sel === "true") st.push("已选中");
    if (el.getAttribute("aria-current")) st.push("当前项");
    if (st.length) bits.push(`(${st.join("、")})`);

    // 可操作元素：带上编号，模型能直接拿去用
    let idx = "";
    if (opts.withIndex && isActionable(el)) {
      const found = findIdxOf(el);
      idx = found !== null ? ` [${found}]` : ` [${reserveIndex(el, null)}]`;
    }
    const indent = "  ".repeat(Math.min(depth, 6));
    return `${indent}${bits.join(" ")}${idx}`;
  }

  // 在当前编号表里找这个元素的编号（没有就返回 null）
  function findIdxOf(el) {
    for (const [k, rec] of idxMap) {
      if (rec && rec.el === el) return k;
    }
    return null;
  }

  // 构建无障碍树文本
  function buildA11yTree(opts = {}) {
    const max = opts.max || 120;
    const filter = opts.filter ? norm(opts.filter).toLowerCase() : "";
    const lines = [];
    let count = 0;

    const walk = (root, depth) => {
      if (count >= max) return;
      const kids = root.children || [];
      for (const el of kids) {
        if (count >= max) return;
        // 隐藏元素不进树（透明的原生勾选框例外——它有可见代理，是真实控件）
        if (!isVisible(el) && !isHiddenToggleUsable(el)) {
          // 仍然要递归进去：折叠面板里的内容在 DOM 里是隐藏的，
          // 但模型可能正要展开它，所以子树留着
        }
        const role = axRole(el);
        const name = labelOf(el);
        // 有名字的容器（form / dialog / region）本身也是重要的结构节点
        const isStructural = role && A11Y_INTERESTING.has(role) && (name || role !== "listitem");
        if (isStructural) {
          const line = a11yNode(el, depth, opts);
          if (line) {
            if (!filter || line.toLowerCase().includes(filter)) {
              lines.push(line);
              count++;
            }
            // 过滤模式下不匹配也要继续往下走（子节点可能匹配）
          }
        }
        // 递归
        if (el.shadowRoot && el.shadowRoot.children) {
          walk(el.shadowRoot, depth + 1);
        }
        if (el.tagName === "IFRAME") {
          try {
            const d = el.contentDocument;
            if (d && d.body) walk(d.body, depth + 1);
          } catch (_) {}
        }
        if (el.children && el.children.length) walk(el, depth + 1);
      }
    };

    walk(document.body, 0);
    return { lines, count };
  }

  // ===== 页面滚动 =====
  // 页面的滚动容器不止 window 一个。典型结构（慕课、知乎、飞书、钉钉、VSCode…）：
  //   <body> 里面套一个 <div class="content">，真正能滚的是这个 div。
  // 只 window.scrollBy 的话页面纹丝不动，但代码却报了"已滚动"——动作发出 ≠ 动作生效。
  // 这里的做法：找出所有能滚的容器 → 挑当前"最该滚"的那个 → 滚 → 回读验证。

  // 一个元素是不是可滚动容器：内容高度超过可视高度，且 overflow 是 auto/scroll/overlay
  function scrollableInfo(el) {
    if (!el || !el.isConnected) return null;
    const st = getComputedStyle(el);
    const oy = st.overflowY;
    if (oy !== "auto" && oy !== "scroll" && oy !== "overlay") return null;
    if (el.scrollHeight - el.clientHeight <= 4) return null; // 内容没超出，滚不动
    return { el, top: el.scrollTop, max: el.scrollHeight - el.clientHeight };
  }

  // 找出页面上所有可滚动的容器（含 window）
  function findScrollables() {
    const out = [];
    // window / documentElement
    const de = document.documentElement;
    if (de && de.scrollHeight - de.clientHeight > 4) {
      out.push({
        el: null, // null 表示 window
        top: window.scrollY || de.scrollTop || 0,
        max: de.scrollHeight - de.clientHeight,
        win: true,
      });
    }
    // 所有元素（含 shadow DOM / 同源 iframe 内的）
    // 用 CSS 选择器先粗筛，省掉对几千个元素逐个 getComputedStyle 的开销：
    // overflow-y 属于 auto/scroll/overlay 的才可能是滚动容器
    const SEL = "*, *::before";
    let cands = [];
    try {
      cands = deepQuery(SEL).map((x) => x.el);
    } catch (_) {
      cands = [];
    }
    for (const el of cands) {
      // 快速过滤：先看尺寸，内容没超出容器的不可能能滚
      try {
        if (el.clientHeight < 40) continue; // 太矮的不是主内容区
      } catch (_) {
        continue;
      }
      const info = scrollableInfo(el);
      if (info) out.push(info);
    }
    return out;
  }

  // 滚当前最该滚的容器，并回读验证是否真的动了
  function scrollActiveContainer(up, amount) {
    const delta = up ? -(Number(amount) || 600) : Number(amount) || 600;
    const cands = findScrollables();
    if (!cands.length) {
      return { ok: false, msg: "页面上没有可滚动的区域" };
    }
    const active = pickScrollTarget(cands, up);
    if (!active) {
      return { ok: false, msg: "页面上没有可滚动的区域" };
    }

    const before = active.top;
    if (active.win) {
      window.scrollBy({ top: delta, behavior: "instant" });
    } else {
      active.el.scrollTop = before + delta;
    }
    // 回读：滚完必须确认位置真的变了，否则就是"没滚动"（不能瞎报成功）
    const after = active.win
      ? window.scrollY || document.documentElement.scrollTop || 0
      : active.el.scrollTop;

    const moved = Math.abs(after - before) > 2;
    if (!moved) {
      // 可能在顶部/底部边界。给模型明确提示，别让它以为滚过了
      const atTop = before <= 4;
      return {
        ok: false,
        msg: atTop
          ? "已经在页面最顶端，往上/往下没有可滚动的空间了"
          : "已经在页面最底端，没有更多内容可滚动了",
      };
    }
    const where = active.win ? "页面" : "内容区";
    return {
      ok: true,
      msg: `已${up ? "向上" : "向下"}滚动${where}（${Math.round(after - before)}px，位置 ${Math.round(after)}/${active.max}）`,
    };
  }

  // 挑该滚哪个容器。
  // 判据（按优先级）：
  //  ① 可滚动总量最大且"滚得动"（max 明显大于一屏）—— 那是主内容区。
  //     慕课/知乎这类站点：内容在内层 div 里能滚几千 px，而 window 只能滚十几 px。
  //     只看"面积最大"会选中 window（它占满视口），但那才是真正没内容可滚的地方。
  //  ② 已经在中间位置（scrollTop 不为 0 也不到底）—— 用户正在看它
  //  ③ 面积最大的
  function pickScrollTarget(cands, up) {
    const vh = window.innerHeight || 800;
    const vw = window.innerWidth || 600;

    const areaOf = (c) => {
      if (c.win) return vh * vw;
      try {
        const r = c.el.getBoundingClientRect();
        const h = Math.max(0, Math.min(r.bottom, vh) - Math.max(r.top, 0));
        const w = Math.max(0, Math.min(r.right, vw) - Math.max(r.left, 0));
        return h * w;
      } catch (_) {
        return 0;
      }
    };

    // ① 主内容区：可滚动总量大，且方向上还有空间
    const roomy = cands.filter((c) => {
      const room = up ? c.top : c.max - c.top;
      return c.max > vh * 1.2 && room > 40;
    });
    if (roomy.length) {
      return [...roomy].sort((a, b) => b.max - a.max)[0];
    }
    // ② 用户正在中间看的
    const mid = cands.find((c) => c.top > 4 && c.max - c.top > 4);
    if (mid) return mid;
    // ③ 面积最大的
    const byArea = [...cands].sort((a, b) => areaOf(b) - areaOf(a))[0];
    return byArea || cands[0];
  }

  // 勾选框的补充标签：自绘复选框自身常常没文字，文字在旁边
  // （比如 <label><input type=checkbox><span class=box></span></label><span>匿名发表</span>）
  function toggleLabel(el) {
    const base = labelOf(el);
    // 原生 checkbox 的 value 默认是 "on"，这种不算有效标签
    if (base && !/^on$|^off$|^none$/.test(base)) return base;
    const own = norm(el.innerText || el.textContent || "");
    if (own) return clip(own, 40);
    // 兄弟节点的文字（<input> + <span>匿名发表</span> 这种并排结构）—— 最准确
    // 但只认"紧邻的下一个兄弟"，且只取一段短文字：旧实现会遍历所有兄弟、
    // 把任意一个 ≤30 字的兄弟文字当成标签，于是提交按钮旁边的复选框会借到
    // "提交"这两个字，find "提交" 就把它也当成命中（用户反馈的误导来源）。
    try {
      const sib = el.nextElementSibling || el.previousElementSibling;
      // 兄弟本身不能再包着别的控件（那就是另一个控件了，不是这个勾选框的文案）
      const clean = sib && !(sib.querySelector && sib.querySelector("button,a,input,select,textarea"));
      if (clean) {
        const t = norm(sib.innerText || sib.textContent || "");
        if (t && t.length <= 20) return clip(t, 40);
      }
    } catch (_) {}
    // 向上找几层祖先的文字（自绘勾选框的文案常在 label 或外层容器上）
    // 祖先里如果还包含别的控件文字（说明它是个大容器），就不采纳
    let node = el;
    for (let d = 0; d < 4; d++) {
      node = node.parentElement;
      if (!node) break;
      const t = norm(node.innerText || node.textContent || "");
      if (!t) continue;
      if (t.length > 30) continue;
      if (node.querySelector && node.querySelector("button,a,input,select,textarea")) {
        // 这个祖先里还有别的控件 → 它多半是列表容器，不是这个勾选框的标签
        // 只有当里面除了自己之外没有别的控件时才用
        const others = node.querySelectorAll("button,a,input,select,textarea");
        let onlySelf = true;
        for (const o of others) {
          if (o !== el && !o.contains(el) && !el.contains(o)) {
            onlySelf = false;
            break;
          }
        }
        if (!onlySelf) continue;
      }
      return clip(t, 40);
    }
    return base || "勾选项";
  }

  // ===== 深度遍历：穿透 Shadow DOM 与同源 iframe =====
  // 现代站点（含不少 AI 自己的编辑器）把输入框放在 shadow root 里，
  // document.querySelectorAll 看不到 → 模型就"找不到输入框"。
  // 同源 iframe（TinyMCE、部分评论编辑器）同理。
  function deepQuery(sel) {
    const out = [];
    const seen = new Set();
    const walk = (root, depth, inFrame) => {
      if (!root || depth > MAX_DEPTH) return;
      let nodes = [];
      try {
        nodes = root.querySelectorAll(sel);
      } catch (_) {
        return;
      }
      for (const n of nodes) {
        if (seen.has(n)) continue;
        seen.add(n);
        out.push({ el: n, inFrame });
      }
      // 继续往下钻：shadow root + 同源 iframe
      let all = [];
      try {
        all = root.querySelectorAll("*");
      } catch (_) {
        all = [];
      }
      for (const n of all) {
        if (n.shadowRoot) walk(n.shadowRoot, depth + 1, inFrame);
        const tag = n.tagName ? n.tagName.toLowerCase() : "";
        if (tag === "iframe" || tag === "frame") {
          let doc = null;
          try {
            doc = n.contentDocument;
          } catch (_) {
            doc = null;
          }
          if (doc && doc !== root) walk(doc, depth + 1, true);
        }
      }
    };
    walk(document, 0, false);
    return out;
  }

  // ===== 快照：可交互元素编号表 =====
  // 防检测：编号表只存在隔离世界内存（Map）里，绝不写 DOM 属性——
  // 页面 JS 即使遍历 DOM 也看不到任何痕迹。页面变化后元素从 Map 中自然失效。
  const idxMap = new Map();

  // find 找到的元素单独存在保留表里：
  // 快照会清空编号表，但 find 的编号必须在下一次动作里继续有效，
  // 否则模型"找到了元素 → 立刻操作"这条最自然的链路会断掉。
  // 保留表的编号不与快照编号冲突：快照分配时跳过这些号。
  const reservedMap = new Map(); // idx -> {el, via}
  const reservedByEl = new WeakMap(); // el -> idx
  let reservedNext = null;


  function snapshot(max) {
    const cap = typeof max === "number" && max > 0 ? max : MAX_ELEMENTS;
    idxMap.clear(); // 重新编号，保证编号与本次快照严格对应
    const found = deepQuery(INTERACTIVE_SEL);
    // 先过滤可见性
    const visible = [];
    for (const { el, inFrame } of found) {
      if (!isVisible(el)) {
        // 隐藏的原生勾选框（自绘样式常见：input 透明/0 尺寸，旁边画方块）
        // 只要有可见的代理容器就仍然要暴露给模型，否则模型永远"找不到那个勾选框"
        if (!isHiddenToggleUsable(el)) continue;
      }
      visible.push({ el, inFrame });
    }
    // 补上"自绘勾选框"（div/span 画方块，没有真实 input 的那种）
    for (const { el, inFrame } of deepQuery("*")) {
      if (!isFakeCheckbox(el)) continue;
      if (!isVisible(el)) continue;
      visible.push({ el, inFrame });
    }
    // 自绘勾选框（div[role=checkbox]）和它内部的原生 input 是同一个控件 → 去重
    const deduped = [];
    const seenCtrls = new Set();
    for (const item of visible) {
      const canon = canonicalToggle(item.el);
      if (canon) {
        if (seenCtrls.has(canon)) continue;
        seenCtrls.add(canon);
        // 用原生 input 代替自绘外壳（它的 checked 状态才是权威的）
        deduped.push({ el: canon, inFrame: item.inFrame, via: item.el !== canon ? item.el : null });
      } else if (isFakeCheckbox(item.el)) {
        // 自绘方块：找它对应的原生 input（可能在兄弟/父容器里）
        const rel = relatedToggleInput(item.el);
        if (rel) {
          if (seenCtrls.has(rel)) continue;
          seenCtrls.add(rel);
          deduped.push({ el: rel, inFrame: item.inFrame, via: item.el });
        } else {
          deduped.push(item);
        }
      } else {
        deduped.push(item);
      }
    }
    // 元素太多时优先保留"可输入"元素、"勾选项"和"视口内"元素 —— 否则输入框、勾选框
    // 会被排在后面的按钮/链接挤掉，模型根本看不到它们（用户反馈：找不到勾选框）
    let picked = deduped;
    if (deduped.length > cap) {
      const score = (x) => {
        let s = 0;
        if (isEditable(x.el)) s += 100;
        if (isToggleLike(x.el)) s += 60;
        if (inViewport(x.el)) s += 30;
        return s;
      };
      const ranked = deduped
        .map((x, i) => ({ x, i, s: score(x) }))
        .sort((a, b) => b.s - a.s || a.i - b.i)
        .slice(0, cap)
        .map((r) => r.x);
      // 恢复文档顺序，编号读起来才自然
      const order = new Map(deduped.map((x, i) => [x.el, i]));
      picked = ranked.sort((a, b) => (order.get(a.el) ?? 0) - (order.get(b.el) ?? 0));
    }
    const list = [];
    for (const { el, inFrame, via } of picked) {
      const tag = el.tagName.toLowerCase();
      const editable = isEditable(el);
      // find 保留过的元素沿用它自己的编号，模型可以直接接着操作
      let idx = reservedByEl.get(el);
      if (idx === undefined) {
        idx = list.length;
        // 跳过 find 保留的编号，避免两个元素撞号
        while (reservedMap.has(idx)) idx++;
      }
      const item = {
        i: idx,
        tag,
        type: el.type || "",
        label: labelOf(el),
        disabled: !!(el.disabled || el.getAttribute("aria-disabled") === "true"),
      };
      // 无障碍角色：让模型知道这是"按钮"还是"链接"还是"开关"，而不只是看标签猜
      const role = axRole(el);
      if (role) item.role = role;
      // 标签算不出来 = 模型只能靠编号瞎猜。明确标出来，提示它改用 a11y/screenshot
      if (!item.label) item.nameless = true;
      if (editable) item.editable = true;
      if (inFrame) item.inFrame = true;
      // 勾选框：暴露当前状态，模型才知道该勾还是该取消
      if (isToggleLike(el)) {
        item.toggle = true;
        item.label = toggleLabel(via || el);
        const st = readToggleState(el);
        if (st !== null) item.checked = st;
        // 自绘外壳（div[role=checkbox]）：点它更可能被组件库识别
        if (via) item.selfClick = true;
      }
      const val = el.value;
      if (val && typeof val === "string" && val.trim() && !item.toggle) item.value = clip(val, 24);
      if (tag === "a" && el.href) item.href = clip(el.href, 56);
      idxMap.set(item.i, { el, via: via || null });
      list.push(item);
    }
    // 列表按编号排序，保证模型看到的编号是递增的
    list.sort((a, b) => a.i - b.i);
    return {
      url: location.href,
      title: document.title,
      elements: list,
      total: deduped.length, // 页面上可交互元素总数（列表被截断时告诉模型）
      truncated: deduped.length > list.length,
      scrollY: Math.round(window.scrollY),
    };
  }

  function reserveIndex(el, via) {
    let i = reservedByEl.get(el);
    if (i !== undefined) return i;
    if (reservedNext === null) {
      let max = -1;
      for (const k of idxMap.keys()) if (k > max) max = k;
      for (const k of reservedMap.keys()) if (k > max) max = k;
      reservedNext = max + 1;
    }
    const idx = reservedNext++;
    reservedMap.set(idx, { el, via: via || null });
    reservedByEl.set(el, idx);
    return idx;
  }

  function findByIdx(idx) {
    const n = Number(idx);
    if (!Number.isFinite(n)) return null;
    const rec = idxMap.get(n) || reservedMap.get(n);
    if (!rec) return null;
    const el = rec.el;
    return el && el.isConnected ? el : null;
  }

  // 取记录（含自绘外壳）——勾选动作需要它
  function recordByIdx(idx) {
    const n = Number(idx);
    if (!Number.isFinite(n)) return null;
    const rec = idxMap.get(n) || reservedMap.get(n);
    if (!rec || !rec.el || !rec.el.isConnected) return null;
    return rec;
  }

  // 给 find 找到的元素分配编号：从当前最大编号往后排，
  // 保证它跟刚给模型的元素列表不冲突（模型用完 find 的编号后可以直接操作）

  // React 等框架受控组件需要用原生 setter 改值
  function setNativeValue(el, value) {
    const proto =
      el instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : el instanceof HTMLSelectElement
          ? HTMLSelectElement.prototype
          : HTMLInputElement.prototype;
    const desc = Object.getOwnPropertyDescriptor(proto, "value");
    if (desc && desc.set) desc.set.call(el, value);
    else el.value = value;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function dispatchMouse(el, type) {
    const r = el.getBoundingClientRect();
    const win = (el.ownerDocument && el.ownerDocument.defaultView) || window;
    const opts = {
      bubbles: true,
      cancelable: true,
      view: win,
      clientX: r.left + r.width / 2,
      clientY: r.top + r.height / 2,
    };
    el.dispatchEvent(new MouseEvent(type, opts));
  }

  // 指针事件：不少现代组件（虚拟列表、地图、自绘控件）只认 pointer*，
  // 合成 MouseEvent 它们根本收不到 —— 这是"点了没反应"的高发原因
  function dispatchPointer(el, type) {
    const r = el.getBoundingClientRect();
    const win = (el.ownerDocument && el.ownerDocument.defaultView) || window;
    try {
      el.dispatchEvent(
        new PointerEvent(type, {
          bubbles: true,
          cancelable: true,
          view: win,
          clientX: r.left + r.width / 2,
          clientY: r.top + r.height / 2,
          pointerId: 1,
          pointerType: "mouse",
          isPrimary: true,
          button: 0,
          buttons: type === "pointerup" ? 0 : 1,
        })
      );
    } catch (_) {
      // PointerEvent 构造失败就退回普通鼠标事件
      dispatchMouse(el, type.replace("pointer", "mouse"));
    }
  }

  // 一次"完整"的点击事件链：指针 + 鼠标 + 一次 click。
  // 注意 click 只派发一次 —— 重复派发会让绑定在 click 上的处理器跑多遍（重复提交）。
  function clickChain(target) {
    try {
      target.focus && target.focus({ preventScroll: true });
    } catch (_) {
      try {
        target.focus && target.focus();
      } catch (_) {}
    }
    dispatchPointer(target, "pointerover");
    dispatchMouse(target, "mouseover");
    dispatchPointer(target, "pointerdown");
    dispatchMouse(target, "mousedown");
    dispatchPointer(target, "pointerup");
    dispatchMouse(target, "mouseup");
    target.click();
  }

  function clickEl(el) {
    clickChain(el);
  }

  // 命中点元素：元素中心位置上真正接收到点击的那个元素
  // （被遮挡层盖住、或模型点到了图标 span 时，真正的可点目标可能不是 el）
  function hitTarget(el) {
    try {
      const r = el.getBoundingClientRect();
      const x = r.left + r.width / 2;
      const y = r.top + r.height / 2;
      const doc = el.ownerDocument || document;
      if (x < 0 || y < 0 || x > (doc.defaultView || window).innerWidth || y > (doc.defaultView || window).innerHeight) {
        return null;
      }
      return doc.elementFromPoint(x, y);
    } catch (_) {
      return null;
    }
  }

  // 最近的"可点祖先"：图标/文字 span 本身没绑事件，事件在<button>祖先上
  function nearestActionable(el) {
    let node = el;
    for (let d = 0; d < 5 && node; d++) {
      if (node !== el && isActionable(node)) return node;
      node = node.parentElement;
    }
    return null;
  }

  // 危险点击：导航 / 表单提交。这类**绝不**多策略重试 ——
  // 万一是"已经生效但没观察到"，再点一次就是开两个标签页 / 提交两遍。
  function isRiskyClick(el) {
    const tag = el.tagName ? el.tagName.toLowerCase() : "";
    if (tag === "a" && el.getAttribute("href")) return true;
    if (tag === "input") {
      const t = (el.type || "").toLowerCase();
      if (t === "submit" || t === "image") return true;
    }
    if (tag === "button") {
      const t = (el.getAttribute("type") || "").toLowerCase();
      if (t === "submit" || t === "image") return true;
      if (!t && el.form) return true; // 表单里的无 type button 默认是 submit
    }
    return false;
  }

  // ===== 多策略点击：这个方式不行就换下一种 =====
  // 用户反馈"元素点了没反应"：单一合成 click 对很多组件根本无效
  // （只认 pointer 事件的、事件绑在祖先上的、只认键盘的、要透过遮挡点到命中点的……）。
  // 策略按"副作用风险从小到大"排列；能观察到页面反应就立刻停，绝不重复触发同一个处理器。
  async function clickWithFallback(el) {
    const label = labelOf(el) || el.tagName.toLowerCase();
    const toggleBefore = isToggleLike(el) ? readToggleState(el) : null;
    const risky = isRiskyClick(el);

    const strategies = [];

    // ① 完整合成事件链（唯一对 el 自己派发 click 的策略，避免重复触发 click 处理器）
    strategies.push({
      name: "合成事件链",
      fn: () => clickChain(el),
    });

    // ② 指针事件链（只发 pointer*，不再发 click —— 不重复触发）
    strategies.push({
      name: "指针事件链",
      fn: () => {
        try {
          el.focus && el.focus({ preventScroll: true });
        } catch (_) {}
        dispatchPointer(el, "pointerover");
        dispatchPointer(el, "pointerdown");
        dispatchPointer(el, "pointerup");
      },
    });

    // ③ 命中点点击：真正接收到点击的元素（遮挡层 / 内部图标）——目标不同才试
    strategies.push({
      name: "命中点点击",
      fn: () => {
        const hit = hitTarget(el);
        if (hit && hit !== el && !el.contains(hit) && !hit.contains(el)) {
          clickChain(hit);
        }
      },
      skipIf: () => {
        const hit = hitTarget(el);
        return !hit || hit === el || el.contains(hit) || hit.contains(el);
      },
    });

    // ④ 可点祖先：事件绑在外层按钮上（模型点到了图标/文字）——目标不同才试
    strategies.push({
      name: "可点祖先",
      fn: () => {
        const p = nearestActionable(el);
        if (p) clickChain(p);
      },
      skipIf: () => {
        const p = nearestActionable(el);
        return !p || p === el;
      },
    });

    // ⑤ 键盘 Enter（不触发 click 处理器，对只认键盘的 widget 有效）
    strategies.push({
      name: "键盘 Enter",
      fn: () => {
        focusEl(el);
        const codes = { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true, cancelable: true };
        el.dispatchEvent(new KeyboardEvent("keydown", codes));
        el.dispatchEvent(new KeyboardEvent("keypress", codes));
        el.dispatchEvent(new KeyboardEvent("keyup", codes));
        if (el.form && typeof el.form.requestSubmit === "function") el.form.requestSubmit();
      },
    });

    // ⑥ 可见代理（label / 自绘外壳）：事件绑在 label 上，input 自己没反应
    strategies.push({
      name: "代理元素",
      fn: () => {
        let proxy = null;
        try {
          proxy = el.closest && el.closest("label");
          if (!proxy && el.id) {
            const doc = el.ownerDocument || document;
            proxy = doc.querySelector(`label[for="${CSS.escape(el.id)}"]`);
          }
          if (!proxy) proxy = el.parentElement && findToggleShell(el.parentElement);
        } catch (_) {}
        if (proxy && proxy !== el) clickChain(proxy);
      },
      skipIf: () => {
        try {
          const lab = (el.closest && el.closest("label")) || null;
          return !lab || lab === el;
        } catch (_) {
          return true;
        }
      },
    });

    const tried = [];
    for (const s of strategies) {
      if (s.skipIf) {
        let skip = false;
        try {
          skip = !!s.skipIf();
        } catch (_) {}
        if (skip) continue;
      }
      let muts = 0;
      let urlChanged = false;
      let mo = null;
      try {
        mo = new MutationObserver((recs) => {
          muts += recs.length;
        });
        mo.observe(document.documentElement, {
          subtree: true,
          childList: true,
          attributes: true,
          characterData: true,
        });
      } catch (_) {}
      const urlBefore = location.href;
      try {
        s.fn();
      } catch (_) {}
      await sleep(220);
      if (mo) {
        try {
          mo.disconnect();
        } catch (_) {}
      }
      urlChanged = location.href !== urlBefore;

      tried.push(s.name);

      // 页面有反应了 → 生效，停止（不再继续点，防重复副作用）
      const stillHere = el.isConnected;
      const toggleAfter = isToggleLike(el) ? readToggleState(el) : null;
      const toggled = toggleBefore !== null && toggleAfter !== toggleBefore;
      const gone = !stillHere;
      if (muts > 0 || urlChanged || toggled || gone) {
        const bits = [s.name];
        if (urlChanged) bits.push("页面已跳转");
        else if (gone) bits.push("元素已消失");
        else if (toggled) bits.push("状态已切换");
        return {
          ok: true,
          msg: `已点击「${clip(label, 24)}」（${bits.join("、")}）`,
          via: s.name,
        };
      }

      // 危险目标（链接/提交）只点一次：宁可报告"没观察到变化"，也绝不能点第二下
      if (risky) break;
    }

    // 全部方式都试过、页面仍无可见变化：
    // 动作确实派发出去了（处理器可能已在后台生效，比如发请求、纯 JS 状态），
    // 所以不能谎报"失败"引导模型重复点；如实说明，让它先观察再决定。
    return {
      ok: true,
      msg:
        `已点击「${clip(label, 24)}」（依次尝试了${tried.length}种方式：${tried.join("、")}），` +
        "但页面没有观察到可见变化",
      hint:
        "这次点击可能已在后台生效（发请求/更新内部状态），也可能这个控件需要真实鼠标输入。" +
        "先用 extract 或 screenshot 确认页面状态，**不要**对同一元素重复点击；" +
        "确认没生效时，改用 find 按文字找它的可点外壳，或换一个等价入口。",
    };
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // ===== 后台任务（defer）：条件触发的页面侧监听器 =====
  // 为什么在这边监听：API 请求有超时（一般 60 秒级），"等视频播完"这种长等待
  // 绝不能塞进对话回合里干等 —— 会超时、烧 token、还可能被 SW 休眠杀掉。
  // 正确做法：本轮立刻收尾 → 页面挂真实监听（video 的 ended 事件等）→
  // 条件满足时通知 service worker → 自动唤醒 AI 从断点继续。
  // 这里只负责"盯条件"，任务状态的持久化在 SW（chrome.storage + alarms）。
  const deferWatchers = new Map(); // taskId -> cleanup()

  function disarmDefer(taskId) {
    const cleanup = deferWatchers.get(taskId);
    if (cleanup) {
      deferWatchers.delete(taskId);
      try {
        cleanup();
      } catch (_) {}
    }
  }

  function fireDefer(taskId, reason) {
    const cleanup = deferWatchers.get(taskId);
    if (!cleanup) return; // 已取消或已触发
    disarmDefer(taskId);
    try {
      const p = chrome.runtime.sendMessage({ type: "defer:fired", taskId, reason: reason || "条件已满足" });
      if (p && p.catch) p.catch(() => {});
    } catch (_) {}
  }

  // 页面上找"要等的那个视频"：指定编号 → 编号元素内部的 video → 页面第一个 video
  function findWaitVideo(targetIdx) {
    if (targetIdx != null) {
      const el = findByIdx(targetIdx);
      if (el) {
        const tag = el.tagName ? el.tagName.toLowerCase() : "";
        if (tag === "video") return el;
        try {
          const inner = el.querySelector && el.querySelector("video");
          if (inner) return inner;
        } catch (_) {}
      }
    }
    try {
      return document.querySelector("video");
    } catch (_) {
      return null;
    }
  }

  function armDefer(taskId, a) {
    disarmDefer(taskId); // 幂等：同 id 重新注册先拆旧的
    const until = (a.until && typeof a.until === "object" ? a.until : { type: String(a.until || "timeout") }) || {};
    const type = String(until.type || until.event || "timeout");
    const cleanups = [];

    if (type === "video-ended") {
      const v = findWaitVideo(until.target != null ? until.target : a.target);
      if (!v) {
        return {
          ok: false,
          msg: "页面上没有找到视频元素，无法等待播放结束",
          hint: "先确认页面上有 <video>；若是画布播放器（B站/YouTube 嵌入），改用 text-appear 等「播放结束」字样，或 timeout 定时唤醒。",
        };
      }
      const onEnded = () => fireDefer(taskId, "视频播放已结束");
      v.addEventListener("ended", onEnded, { once: true });
      cleanups.push(() => v.removeEventListener("ended", onEnded));
      // 已经播完了（注册时就 ended）→ 立刻触发
      try {
        if (v.ended) {
          setTimeout(() => fireDefer(taskId, "视频已经播放结束"), 0);
        }
      } catch (_) {}
    } else if (type === "text-appear") {
      const q = norm(until.text || a.text || "").toLowerCase();
      if (!q) return { ok: false, msg: "text-appear 需要 until.text 指定要等的文字" };
      const check = () => {
        let txt = "";
        try {
          txt = norm(document.body && document.body.innerText).toLowerCase();
        } catch (_) {}
        return txt.includes(q);
      };
      if (check()) {
        setTimeout(() => fireDefer(taskId, `页面上已出现「${clip(until.text, 20)}」`), 0);
      } else {
        const mo = new MutationObserver(() => {
          if (check()) fireDefer(taskId, `页面上出现了「${clip(until.text, 20)}」`);
        });
        try {
          mo.observe(document.documentElement, { subtree: true, childList: true, characterData: true });
          cleanups.push(() => mo.disconnect());
        } catch (_) {}
      }
    } else if (type === "element-appear") {
      // 等某个带文字的元素出现（比 text-appear 更精确：必须是可交互/可识别元素）
      const q = norm(until.text || a.text || "").toLowerCase();
      if (!q) return { ok: false, msg: "element-appear 需要 until.text 指定要等的元素文字" };
      const check = () => {
        try {
          for (const { el } of deepQuery(INTERACTIVE_SEL)) {
            if (searchText(el).includes(q) && isVisible(el)) return true;
          }
        } catch (_) {}
        return false;
      };
      if (check()) {
        setTimeout(() => fireDefer(taskId, `元素「${clip(until.text, 20)}」已出现`), 0);
      } else {
        const mo = new MutationObserver(() => {
          if (check()) fireDefer(taskId, `元素「${clip(until.text, 20)}」出现了`);
        });
        try {
          mo.observe(document.documentElement, { subtree: true, childList: true, attributes: true });
          cleanups.push(() => mo.disconnect());
        } catch (_) {}
      }
    } else if (type === "timeout") {
      // 定时唤醒：主定时器在 SW 的 chrome.alarms（SW 休眠也能醒）；
      // 页面这边补一个同长的 setTimeout 兜底（页面被关则自然失效，SW alarm 仍会触发）
      const sec = Math.min(86400, Math.max(1, Number(until.seconds) || 30));
      const t = setTimeout(() => fireDefer(taskId, `定时唤醒（${sec} 秒）`), sec * 1000);
      cleanups.push(() => clearTimeout(t));
    } else {
      return {
        ok: false,
        msg: `未知的等待条件类型：${type}`,
        hint: "until.type 只支持 video-ended / text-appear / element-appear / timeout。",
      };
    }

    deferWatchers.set(taskId, () => {
      for (const c of cleanups) {
        try {
          c();
        } catch (_) {}
      }
    });
    return {
      ok: true,
      deferred: true,
      taskId,
      msg: `已挂起后台任务（等待条件：${type}），条件满足后自动继续`,
    };
  }

  // SW / 侧栏可以来取消页面侧的监听
  try {
    chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
      if (msg && msg.type === "defer:cancel" && msg.taskId) {
        disarmDefer(msg.taskId);
        sendResponse({ ok: true });
        return true;
      }
      if (msg && msg.type === "defer:ping") {
        sendResponse({ ok: true, watching: [...deferWatchers.keys()] });
        return true;
      }
      return false;
    });
  } catch (_) {}

  // ===== 输入：借鉴 Kimi 的思路，走"真实编辑管道"而不是直接改 DOM =====
  // 直接 el.textContent = v 只能改表面 DOM：
  //   · ProseMirror / Quill / Slate / Lexical 维护自己的文档模型 → 页面拿不到内容，提交出去是空的
  //   · 很多编辑器还会在下一次渲染时把内容冲掉
  // 用 document.execCommand("insertText") 会派发 beforeinput / input 事件，
  // 框架能正常同步自己的模型 —— 这是浏览器里唯一"像真人打字"的纯 DOM 路径。
  //（真正 100% 可信的 isTrusted=true 事件要走 CDP Input 域，那是 0.3 的事）

  function selectAllIn(el) {
    const doc = el.ownerDocument || document;
    try {
      const sel = doc.getSelection();
      const range = doc.createRange();
      range.selectNodeContents(el);
      sel.removeAllRanges();
      sel.addRange(range);
      return sel;
    } catch (_) {
      return null;
    }
  }

  function readEditableText(el) {
    try {
      const t = el.innerText != null && el.innerText !== "" ? el.innerText : el.textContent;
      // 去掉 &nbsp; 和零宽字符，否则和期望值永远对不上
      return String(t || "")
        .replace(/[\u00a0\u200b\ufeff]/g, " ")
        .replace(/\s+/g, " ")
        .trim();
    } catch (_) {
      return "";
    }
  }

  // 聚焦元素（跨 iframe 时还要把 iframe 自己的窗口也聚焦，否则 execCommand 会失败）
  function focusEl(el) {
    const doc = el.ownerDocument || document;
    const win = doc.defaultView || window;
    try {
      if (win !== window && typeof win.focus === "function") win.focus();
    } catch (_) {}
    try {
      el.focus({ preventScroll: true });
    } catch (_) {
      try {
        el.focus();
      } catch (_) {}
    }
  }

  function fillContentEditable(el, text) {
    const doc = el.ownerDocument || document;
    focusEl(el);
    // 选中全部既有内容，随后 insertText 会替换掉它
    selectAllIn(el);
    let ok = false;
    try {
      ok = !!doc.execCommand("insertText", false, text);
    } catch (_) {
      ok = false;
    }
    if (!ok) {
      // 退化路径：直接改 DOM + 补发 input 事件（至少让简单编辑器认）
      el.textContent = text;
      try {
        el.dispatchEvent(
          new InputEvent("input", {
            bubbles: true,
            inputType: "insertText",
            data: text,
          })
        );
      } catch (_) {
        el.dispatchEvent(new Event("input", { bubbles: true }));
      }
    }
    return ok;
  }

  // 拟人打字节奏：每个字符之间随机停顿，标点后停久一点，偶尔"想一下"。
//
// 为什么要它：一次性把整段文字写进表单，行为特征太"机器"（0 毫秒写完），
// 一些站点会据此判定为脚本。按真人节奏逐字输入可以显著降低被识别的概率。
// 但也更慢：默认 fill 仍然是一次写入，只有你显式要求 human 时才走这条路。
  const TYPING_SPEEDS = {
    fast: { min: 22, max: 55, think: 120, thinkEvery: [12, 22] },
    normal: { min: 45, max: 110, think: 260, thinkEvery: [7, 14] },
    slow: { min: 110, max: 240, think: 520, thinkEvery: [5, 10] },
  };
  const PUNCT_PAUSE = { "，": 1.7, "。": 2.1, "！": 2.1, "？": 2.1, "；": 1.6, "：": 1.5, "、": 1.3, ",": 1.6, ".": 1.8, "!": 1.8, "?": 1.8, ";": 1.5, ":": 1.4, "\n": 2.4 };

  function typingProfile(opts) {
    const preset =
      typeof opts.speed === "string" && TYPING_SPEEDS[opts.speed]
        ? TYPING_SPEEDS[opts.speed]
        : TYPING_SPEEDS.normal;
    const min = Number(opts.minDelay) > 0 ? Number(opts.minDelay) : preset.min;
    const max = Number(opts.maxDelay) > min ? Number(opts.maxDelay) : Math.max(min + 20, preset.max);
    return { min, max, think: preset.think, thinkEvery: preset.thinkEvery };
  }

  function rand(min, max) {
    return min + Math.random() * Math.max(1, max - min);
  }

  function charsOf(s) {
    return Array.from(String(s || "")).length;
  }

  // 逐字输入：每个字符都走一次 keydown → beforeinput → insertText → input → keyup，
  // 并保持真人节奏（异步，因此调用方必须 await）。
  async function typeIntoEditable(el, text, opts = {}) {
    const doc = el.ownerDocument || document;
    const prof = typingProfile(opts);
    focusEl(el);
    selectAllIn(el);
    const chars = Array.from(String(text || ""));
    let sinceThink = 0;
    let nextThink = Math.round(rand(prof.thinkEvery[0], prof.thinkEvery[1]));

    for (let i = 0; i < chars.length; i++) {
      const ch = chars[i];
      const code = ch.charCodeAt(0);
      const keyOpts = {
        key: ch,
        code: /[a-zA-Z]/.test(ch) ? "Key" + ch.toUpperCase() : /[0-9]/.test(ch) ? "Digit" + ch : /^\s$/.test(ch) ? "Space" : "",
        bubbles: true,
        cancelable: true,
        keyCode: code,
        which: code,
      };
      try {
        el.dispatchEvent(new KeyboardEvent("keydown", keyOpts));
      } catch (_) {}
      try {
        el.dispatchEvent(new KeyboardEvent("keypress", keyOpts));
      } catch (_) {}
      try {
        const be = new InputEvent("beforeinput", {
          bubbles: true,
          cancelable: true,
          inputType: "insertText",
          data: ch,
        });
        el.dispatchEvent(be);
      } catch (_) {}

      let inserted = false;
      try {
        inserted = doc.execCommand("insertText", false, ch);
      } catch (_) {
        inserted = false;
      }
      if (!inserted) {
        // 退路：直接改文本 + 补一个 input 事件（内容型编辑器靠这个）
        if ("value" in el) el.value = (el.value || "") + ch;
        else el.textContent = (el.textContent || "") + ch;
        try {
          el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: ch }));
        } catch (_) {
          el.dispatchEvent(new Event("input", { bubbles: true }));
        }
      }

      try {
        el.dispatchEvent(new KeyboardEvent("keyup", keyOpts));
      } catch (_) {}

      // 节奏：基础随机间隔 + 标点后加长 + 偶尔"想一下"
      let wait = rand(prof.min, prof.max);
      const mult = PUNCT_PAUSE[ch];
      if (mult) wait *= mult;
      sinceThink++;
      if (sinceThink >= nextThink) {
        wait += rand(prof.think * 0.6, prof.think * 1.4);
        sinceThink = 0;
        nextThink = Math.round(rand(prof.thinkEvery[0], prof.thinkEvery[1]));
      }
      await autoSleep(wait);
    }
    try {
      el.dispatchEvent(new Event("change", { bubbles: true }));
    } catch (_) {}
  }

  function fillPlainInput(el, text) {
    el.focus();
    try {
      const desc = Object.getOwnPropertyDescriptor(
        el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype,
        "value"
      );
      if (desc && desc.set) desc.set.call(el, text);
      else el.value = text;
    } catch (_) {
      el.value = text;
    }
    // React 18 只认带 inputType 的 InputEvent
    try {
      el.dispatchEvent(
        new InputEvent("input", { bubbles: true, inputType: "insertText", data: text })
      );
    } catch (_) {
      el.dispatchEvent(new Event("input", { bubbles: true }));
    }
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }

  // 回读验证：动作"发出"不等于"生效"（借鉴 Kimi 的点击投递探针思路）
  function verifyFilled(el, text) {
    const want = String(text || "").trim();
    if (!want) return true;
    const got = el.tagName.toLowerCase() === "input" || el.tagName.toLowerCase() === "textarea"
      ? String(el.value || "").trim()
      : readEditableText(el);
    if (!got) return false;
    if (got === want) return true;
    // 富文本编辑器常在末尾留一个 <br> / 换行，宽松包含即可
    return got.replace(/\s+/g, "") === want.replace(/\s+/g, "");
  }

  // ===== 动作执行 =====
  async function act(a) {
    if (!a || typeof a !== "object") return { ok: false, msg: "动作无效" };
    const needTarget = ["click", "fill", "select", "check", "extract", "focus"].includes(a.action);
    let el = null;
    if (needTarget || a.target != null) {
      el = findByIdx(a.target);
      if (needTarget && !el) {
        return { ok: false, msg: `元素 #${a.target} 不存在（页面可能已变化，请重新观察元素列表）` };
      }
      if (el && (el.disabled || el.getAttribute("aria-disabled") === "true")) {
        return { ok: false, msg: `元素 #${a.target} 已禁用` };
      }
    }

    switch (a.action) {
      case "click": {
        el.scrollIntoView({ block: "center", behavior: "instant" });
        return await clickWithFallback(el);
      }
      case "fill": {
        const v = a.value == null ? "" : String(a.value);
        el.scrollIntoView({ block: "center", behavior: "instant" });
        // human:true → 不一次性写完，改成真人节奏逐字输入（用于有反自动化检测的站点）
        const human = a.human === true || a.human === "true" || a.typing === "human";
        if (human) {
          if (isRichText(el)) {
            try {
              el.innerHTML = "";
            } catch (_) {}
          } else {
            fillPlainInput(el, "");
          }
          await typeIntoEditable(el, v, a);
          if (verifyFilled(el, v)) {
            return { ok: true, msg: `已按真人节奏输入「${clip(v, 30)}」（${charsOf(v)} 字符）` };
          }
          return {
            ok: false,
            msg: `按真人节奏输入「${clip(v, 30)}」后没有读到内容`,
            hint: "该元素可能不是可输入区域，或需要先 click 聚焦；也可能它确实抗拒逐字输入（那就用 fill 一次性写入）。",
          };
        }
        if (isRichText(el)) {
          fillContentEditable(el, v);
        } else {
          fillPlainInput(el, v);
        }
        // 回读验证：编辑器可能拒绝这次输入（比如它有自己的状态机）
        if (!verifyFilled(el, v)) {
          // 第二级兜底：逐字输入（走 keydown → insertText → keyup 事件流）
          if (isRichText(el)) {
            try {
              el.innerHTML = "";
            } catch (_) {}
            await typeIntoEditable(el, v, a);
            if (verifyFilled(el, v)) {
              return { ok: true, msg: `已填入「${clip(v, 30)}」（逐字输入）` };
            }
          }
          return {
            ok: false,
            msg: `已尝试写入「${clip(v, 30)}」，但页面没有接受这次输入`,
            hint:
              "如果这是富文本编辑器：先对该元素执行 click 让它获得焦点，再重试 fill；" +
              "若它在 iframe / shadow DOM 里，也先点一下再试。仍不行就用 extract 看看它当前内容，" +
              "必要时改用 type 逐字输入（要更慢更逼真可加 \"human\":true 与 \"speed\":\"slow\"）。",
          };
        }
        return { ok: true, msg: `已填入「${clip(v, 30)}」` };
      }
      case "type": {
        // 逐字输入：给那些只认真人按键流的编辑器（评论框、聊天输入、快捷指令框），
        // 也是"怕被网页判定成脚本"时的选择。默认 normal 节奏，可传 speed: fast/normal/slow。
        const v = a.value == null ? "" : String(a.value);
        const target = (a.target != null ? findByIdx(a.target) : null) || document.activeElement;
        if (!target) return { ok: false, msg: "没有可输入的目标元素" };
        target.scrollIntoView({ block: "center", behavior: "instant" });
        if (isRichText(target)) {
          await typeIntoEditable(target, v, a);
        } else {
          fillPlainInput(target, "");
          await typeIntoEditable(target, v, a);
        }
        if (!verifyFilled(target, v)) {
          return {
            ok: false,
            msg: `逐字输入「${clip(v, 30)}」后没有读到内容`,
            hint: "该元素可能不是可输入区域，请换用 fill，或先 click 让它聚焦。",
          };
        }
        return { ok: true, msg: `已逐字输入「${clip(v, 30)}」` };
      }
      case "select": {
        if (el.tagName.toLowerCase() !== "select") {
          return { ok: false, msg: `元素 #${a.target} 不是下拉框` };
        }
        const v = a.value == null ? "" : String(a.value);
        const opts = [...el.options];
        let opt =
          opts.find((o) => o.value === v) ||
          opts.find((o) => norm(o.text) === norm(v)) ||
          opts.find((o) => norm(o.text).includes(norm(v)));
        if (!opt) {
          return {
            ok: false,
            msg: `没找到选项「${clip(v, 30)}」，可选项：${opts.slice(0, 8).map((o) => norm(o.text)).join(" / ")}`,
          };
        }
        el.focus();
        setNativeValue(el, opt.value);
        return { ok: true, msg: `已选择「${norm(opt.text)}」` };
      }
      case "check": {
        const want = a.value === undefined ? true : !!a.value;
        // 找出这个勾选框的"权威目标"：可能是原生 input，也可能是 role/aria 勾选框，
        // 也可能是模型点到的"匿名发表"文字（要顺藤摸瓜找到旁边的那个 input）
        const rec = recordByIdx(a.target);
        const shell = rec && rec.via ? rec.via : null;
        // 目标本身就是按钮/链接/输入框这类"不可能有勾选状态"的控件时，
        // 直接如实报错。绝不能让下面的 resolveToggle 兜底摸到旁边无关的复选框，
        // 否则会返回"已处于勾选状态"，模型据此以为按钮被勾选了。
        if (isDefinitelyNotToggle(el) && !(shell && isToggleLike(shell))) {
          return {
            ok: false,
            msg: `元素 #${a.target} 不是勾选项（它是${(el.tagName || "").toLowerCase()} 控件，没有勾选状态）`,
            hint:
              "要对按钮执行动作请用 click；只有复选框/单选框/开关才用 check。" +
              "若页面上有可见的方框，请用 find 按它旁边的文字定位（例如 " +
              '{"action":"find","text":"匿名发表"}），再对返回的编号执行 check。',
          };
        }
        const t = resolveToggle(el) || (shell ? resolveToggle(shell) : null);
        if (!t) {
          return {
            ok: false,
            msg: `元素 #${a.target} 不是勾选项`,
            hint:
              "它可能不是勾选框。若页面上有可见的方框，请用 find 动作按文字找到它（例如 " +
              '{"action":"find","text":"匿名发表"}），再对返回的编号执行 check。',
          };
        }
        const before = t.state();
        // 已经处于目标状态就不重复点（避免把已勾选的又取消掉）
        if (before !== null && before === want) {
          return { ok: true, msg: want ? "已处于勾选状态" : "已处于未勾选状态" };
        }
        // 单选框不能"取消勾选"——只能选中
        if (!want && t.kind === "radio") {
          return { ok: false, msg: "单选框不能取消勾选，只能选择其它项" };
        }

        // ===== 第一步：点原生 input（或 role 勾选框）=====
        // 原生 input 即使视觉上被隐藏（opacity:0），程序化 .click() 依然会切换 checked
        // 并派发 change 事件 —— 这正是 antd/element-ui 这类自绘复选框的工作方式。
        let clicked = false;
        try {
          t.el.scrollIntoView({ block: "center", behavior: "instant" });
        } catch (_) {}
        if (t.el.tagName.toLowerCase() === "input") {
          t.el.click();
          clicked = true;
        } else {
          clickEl(t.el);
          clicked = true;
        }

        // ===== 回读验证：动作"发出"不等于"生效" =====
        let after = t.state();
        if (after !== want) {
          // 第二步兜底：连点自绘外壳（组件库常把 click handler 绑在外壳上）
          const shellEl = shell || (t.el.parentElement && findToggleShell(t.el.parentElement));
          if (shellEl && shellEl !== t.el) {
            try {
              shellEl.scrollIntoView({ block: "center", behavior: "instant" });
            } catch (_) {}
            clickEl(shellEl);
            await sleep(120);
            after = t.state();
          }
        }
        if (after !== want && t.el.tagName.toLowerCase() === "input") {
          // 第三步兜底：直接改 checked 再派发 change（少数框架只认 change 事件）
          try {
            t.el.checked = want;
            t.el.dispatchEvent(new Event("change", { bubbles: true }));
            t.el.dispatchEvent(new Event("input", { bubbles: true }));
          } catch (_) {}
          await sleep(120);
          after = t.state();
        }

        if (after === want) {
          return { ok: true, msg: want ? "已勾选" : "已取消勾选" };
        }
        return {
          ok: false,
          msg: `点击了勾选框但状态没有变成${want ? "勾选" : "未勾选"}`,
          hint:
            "这个勾选框可能是自绘组件，click 没有触发它的切换逻辑。" +
            "请改用 find 动作按文字找到它（例如 {\"action\":\"find\",\"text\":\"匿名发表\"}），" +
            "或对它先执行 click 再观察；也可以用 screenshot 看页面实际状态。",
        };
      }
      case "press": {
        const key = a.key || "Enter";
        const target = (a.target != null ? findByIdx(a.target) : null) || document.activeElement || document.body;
        focusEl(target);
        // 很多老代码只认 keyCode/which，补上提高兼容性
        const codes = { Enter: 13, Tab: 9, Escape: 27, Backspace: 8, Delete: 46, ArrowUp: 38, ArrowDown: 40, ArrowLeft: 37, ArrowRight: 39, Space: 32 };
        const code = codes[key] != null ? codes[key] : key.length === 1 ? key.charCodeAt(0) : 0;
        const kc = { key, code: key.length === 1 ? "Key" + key.toUpperCase() : key, keyCode: code, which: code, bubbles: true, cancelable: true };
        const before = isRichText(target) ? readEditableText(target) : null;
        target.dispatchEvent(new KeyboardEvent("keydown", kc));
        target.dispatchEvent(new KeyboardEvent("keypress", kc));
        target.dispatchEvent(new KeyboardEvent("keyup", kc));
        // 合成事件不触发浏览器默认行为，Enter 提交表单需要手动补
        if (key === "Enter" && target.form && typeof target.form.requestSubmit === "function") {
          target.form.requestSubmit();
        }
        // 富文本编辑器：框架自己处理了 Enter（提交/换行）就不插手；
        // 内容没变化的（纯 contenteditable，没框架）才补一个换行，避免多插一行。
        if (key === "Enter" && before != null && isRichText(target) && readEditableText(target) === before) {
          try {
            const doc = target.ownerDocument || document;
            if (!doc.execCommand("insertLineBreak")) doc.execCommand("insertText", false, "\n");
          } catch (_) {}
        }
        return { ok: true, msg: `已按下 ${key}` };
      }
      case "scroll": {
        const up = a.direction === "up";
        // 指定了目标元素 → 滚到那个元素
        if (a.target != null) {
          const t = findByIdx(a.target);
          if (t) {
            t.scrollIntoView({ block: "center", behavior: "instant" });
            return { ok: true, msg: `已滚动到元素 #${a.target}` };
          }
        }
        // 没指定元素 → 滚"当前真正能滚的那个容器"。
        // 关键：只 window.scrollBy 是不够的 —— 很多站点（慕课、知乎、飞书、钉钉…）
        // 的内容放在一个内层可滚动 div 里，滚 window 页面纹丝不动，
        // 但我们的动作却报了"已向下滚动"（用户反馈：滚动根本没生效）。
        // 所以这里要找到真正可滚的容器，滚完再回读验证。
        const scrolled = scrollActiveContainer(up, a.amount);
        if (!scrolled.ok) {
          return {
            ok: false,
            msg: scrolled.msg,
            hint:
              "页面没有可滚动的区域（可能内容都在一屏内，或者滚动区在 iframe/画布里）。" +
              "可以改用 find 定位元素后用 click，或用 screenshot 看页面实际样子。",
          };
        }
        return { ok: true, msg: scrolled.msg };
      }
      case "navigate": {
        const url = String(a.url || "").trim();
        if (!/^https?:\/\//i.test(url)) {
          return { ok: false, msg: "仅支持 http(s) 网址" };
        }
        location.href = url;
        return { ok: true, msg: "正在跳转…" };
      }
      case "extract": {
        const t = el ? el.innerText || el.textContent || "" : document.body.innerText || "";
        const text = norm(t);
        return {
          ok: true,
          msg: el ? `已提取元素 #${a.target} 文本` : "已提取页面文本",
          data: text.slice(0, 2000),
        };
      }
      case "find": {
        // 按文字定位元素：页面元素太多时（几十条回复、上百个按钮），
        // 模型光靠编号列表找不到目标 —— 让它按文字搜。
        const q = norm(a.text || a.query || "").toLowerCase();
        if (!q) {
          return { ok: false, msg: "find 动作需要 text 参数，例如 {\"action\":\"find\",\"text\":\"匿名发表\"}" };
        }
        // 收集全部候选（不受可见性上限影响）
        const cands = [];
        const candSeen = new Set();
        for (const { el, inFrame } of deepQuery(INTERACTIVE_SEL)) {
          if (!isVisible(el) && !isHiddenToggleUsable(el)) continue;
          if (candSeen.has(el)) continue;
          candSeen.add(el);
          cands.push({ el, inFrame });
        }
        for (const { el, inFrame } of deepQuery("*")) {
          if (!isFakeCheckbox(el) || !isVisible(el)) continue;
          if (candSeen.has(el)) continue;
          candSeen.add(el);
          cands.push({ el, inFrame });
        }
        // 两遍匹配：先只用"元素自己的文字"，找不到再退回"旁注文字"（勾选框的 label
        // 常常在兄弟节点上，勾选框自身没有这段文字）。
        // 为什么必须分两遍：搜"提交"时，提交按钮的自身文字命中；而它旁边那个复选框会
        // 通过 toggleLabel 借到"提交"这两个字。如果混在一起返回，模型就会把那个复选框
        // 当成提交按钮，进而说出"提交按钮已处于勾选状态"（用户反馈的真实 bug）。
        const directHits = [];
        const borrowedHits = [];
        for (const c of cands) {
          // 跳过"整块容器"（它的文字里恰好包含了关键词，但本身不是一个控件）
          // ——比如回复区容器，它的 innerText 里有"匿名发表"，但它不是能点的东西
          if (!isToggleLike(c.el) && !isActionable(c.el)) continue;
          if (directSearchText(c.el).includes(q)) directHits.push(c);
          else if (searchText(c.el).includes(q)) borrowedHits.push(c);
        }
        let hits = directHits.length ? directHits : borrowedHits;
        hits = hits.slice(0, 12);
        const hitSet = new Set(hits.map((h) => h.el));
        // 兜底：文字在纯文本节点上（如 <span>匿名发表</span>），勾选框本身没这段文字。
        // 这时把"文字所在的元素"也作为命中，并顺藤摸瓜找到它旁边的勾选框。
        if (!hits.length) {
          for (const { el, inFrame } of deepQuery("*")) {
            if (hitSet.has(el)) continue;
            if (!isVisible(el)) continue;
            // 必须是"纯文字元素"：内部不能还有别的控件，否则它是个容器（比如整个回复区）
            if (el.querySelector && el.querySelector("button,a,input,select,textarea")) continue;
            const own = norm(el.innerText || el.textContent || "");
            if (!own || own.length > 40) continue;
            if (!own.toLowerCase().includes(q)) continue;
            // 命中目标优先级：元素自己就是控件（按钮/自定义按钮/label）→ 用它自己；
            // 只有纯文字节点（span 之类）才去顺藤摸瓜找旁边的勾选框。
            // 旧逻辑把"旁边的勾选框"排在元素自己前面，导致搜"提交"时把提交按钮
            // 旁边的复选框当成了目标 —— 这正是用户看到"提交是勾选框"的来源。
            let target;
            if (isActionable(el) || isToggleLike(el)) {
              target = el;
            } else {
              target = findNearbyToggle(el) || nearestActionable(el) || el;
            }
            hits.push({ el: target, inFrame, text: target === el ? "" : own });
            hitSet.add(el);
            if (target !== el) hitSet.add(target);
            if (hits.length >= 12) break;
          }
        }
        if (!hits.length) {
          return {
            ok: false,
            msg: `页面上没有找到包含「${clip(a.text || a.query || "", 20)}」的元素`,
            hint:
              "换用页面上真实出现的文字再试（按钮/复选框旁边的文字），" +
              "或先 scroll 页面让目标进入视口后再找；也可以用 screenshot 看页面实际长样子。",
          };
        }
        // 把命中的元素登记进编号表，模型可以直接对返回的编号操作
        const lines = [];
        const seenTargets = new Set();
        for (const h of hits) {
          const canon = canonicalToggle(h.el) || (isFakeCheckbox(h.el) ? relatedToggleInput(h.el) : null);
          const target = canon || h.el;
          // 同一个控件可能被多条路径命中（元素本身 + 旁边的文字 + 外壳）→ 只列一次
          if (seenTargets.has(target)) continue;
          seenTargets.add(target);
          const idx = reserveIndex(target, h.el !== target ? h.el : null);
          const kind = isToggleLike(target) ? " [勾选框]" : "";
          const st = isToggleLike(target) ? readToggleState(target) : null;
          const stTxt = st === null ? "" : st ? "（已勾选）" : "（未勾选）";
          const name = h.text || toggleLabel(h.el) || labelOf(h.el) || searchText(h.el);
          lines.push(`[${idx}] ${target.tagName.toLowerCase()}${kind}「${clip(name, 30)}」${stTxt}`);
        }
        if (!lines.length) {
          return {
            ok: false,
            msg: `页面上没有找到可操作的「${clip(a.text || a.query || "", 20)}」`,
            hint: "换个关键词再试，或用 screenshot 看页面实际样子。",
          };
        }
        return {
          ok: true,
          msg: `找到 ${lines.length} 个匹配「${clip(a.text || a.query || "", 20)}」的元素`,
          data: lines.join("\n"),
        };
      }
      case "a11y": {
        // 无障碍树：模型靠它按"角色+名字"定位元素，而不是靠编号瞎猜
        const filter = a.text || a.query || "";
        const tree = buildA11yTree({
          filter: filter,
          max: a.max ? Math.min(400, Math.max(20, Number(a.max) || 120)) : 120,
          withIndex: true,
        });
        if (!tree.lines.length) {
          return {
            ok: false,
            msg: filter
              ? `无障碍树里没有找到包含「${clip(filter, 20)}」的节点`
              : "无障碍树是空的（页面可能没加载完）",
            hint: "先 wait 等页面渲染完再试；也可以用 screenshot 看页面实际样子。",
          };
        }
        const head = filter
          ? `【无障碍树 · 过滤「${clip(filter, 20)}」】`
          : "【无障碍树】按角色和名称组织的页面结构，方括号里是可操作元素的编号：";
        const tail =
          "\n（用方括号里的编号直接 click/fill/check；找不到想要的就换关键词再查，或用 screenshot 看页面实际样子）";
        return {
          ok: true,
          msg: `已生成无障碍树（${tree.lines.length} 个节点）`,
          data: head + "\n" + tree.lines.join("\n") + tail,
        };
      }
      case "wait": {
        await sleep(a.ms || 1000);
        return { ok: true, msg: `已等待 ${a.ms || 1000}ms` };
      }
      case "defer": {
        // 正常路径由侧栏 runPageAction 直接调 armDefer；这里兜底，防止动作漏到通用执行
        return armDefer(a.taskId || "task_fallback_" + Date.now(), a);
      }
      case "focus": {
        el.scrollIntoView({ block: "center", behavior: "instant" });
        el.focus();
        return { ok: true, msg: `已聚焦元素 #${a.target}` };
      }
      default:
        return { ok: false, msg: "未知动作：" + a.action };
    }
  }

  // ===== 页面顶部"AI 正在操控"横条（Shadow DOM，不吃页面样式）=====
  const BANNER_ID = "__ai_ctl_banner";

  function banner(show, text) {
    const old = document.getElementById(BANNER_ID);
    if (!show) {
      if (old) old.remove();
      return true;
    }
    if (old) return true;
    const host = document.createElement("div");
    host.id = BANNER_ID;
    host.style.cssText =
      "all:initial;position:fixed;top:0;left:0;right:0;z-index:2147483647;pointer-events:none;";
    const root = host.attachShadow({ mode: "open" });
    const bar = document.createElement("div");
    bar.style.cssText = [
      "height:28px",
      "display:flex",
      "align-items:center",
      "justify-content:center",
      "gap:8px",
      "font:600 12px/1.4 -apple-system,'Segoe UI','Microsoft YaHei',sans-serif",
      "color:#04211d",
      "background:linear-gradient(90deg,#5eead4,#2dd4bf 45%,#14b8a6)",
      "box-shadow:0 2px 12px rgba(0,0,0,.22)",
    ].join(";");
    const dot = document.createElement("span");
    dot.style.cssText = "width:8px;height:8px;border-radius:50%;background:#04211d;opacity:.7;";
    const label = document.createElement("span");
    label.textContent = text || "AI 正在操控此页面 · 可在侧栏点停止中断";
    bar.appendChild(dot);
    bar.appendChild(label);
    root.appendChild(bar);
    document.documentElement.appendChild(host);
    return true;
  }

  // ===== 自动化任务：把"重复性动作"交给程序跑循环 =====
  //
  // 为什么要有它：像"点一下等两秒、循环 3 次""PPT 一页页翻到底"这类事，
  // 如果每步都走一次模型，又慢又费 token。AI 只需要声明"循环做什么 / 什么时候停"，
  // 循环在这里跑完，跑完再唤醒 AI 检查现状、接着干剩下的。
  //
  // 安全性：① 迭代上限 500；② 总时长上限（默认 2 分钟，最多 10 分钟）；
  //         ③ 连续 5 轮动作全部失败就停；④ 正常结束与异常都会回报，绝不静默卡死。
  const AUTOMATE_MAX_ITER = 500;
  const AUTOMATE_MAX_MS = 10 * 60 * 1000;
  const AUTOMATE_FAIL_LIMIT = 5;

  function autoSleep(ms) {
    return new Promise((r) => setTimeout(r, Math.max(0, Math.min(20000, ms || 0))));
  }

  function keyCodeOf(key) {
    const map = {
      ArrowRight: 39,
      ArrowLeft: 37,
      ArrowDown: 40,
      ArrowUp: 38,
      PageDown: 34,
      PageUp: 33,
      Enter: 13,
      Space: 32,
      " ": 32,
    };
    return map[key] || 0;
  }

  // 页面"看起来变了没"：用于 nochange 停止条件（翻到底/没有下一页了）
  function pageSignature() {
    try {
      const t = (document.body && document.body.innerText) || "";
      const marks = (t.match(/第\s*\d+\s*页|\d+\s*\/\s*\d+/g) || []).join("|");
      return [
        document.title,
        location.href,
        t.length,
        marks,
        window.scrollY,
        document.body ? document.body.scrollHeight : 0,
      ].join("|");
    } catch (_) {
      return String(Date.now());
    }
  }

  // 把步骤翻译成"标准动作"后交给 act() 执行。
  //
  // ⚠️ 关键设计（别再改回自己实现）：
  //    自动化**不自己实现点击/填写**，而是复用 AI 手动操作时的同一套工具
  //    —— 先 find 解析目标（多策略定位、编号表），再 act 执行（合成事件链、回读校验、
  //    富文本处理都在里面）。自动化只是把这些工具调用"串联起来跑循环"。
  //    我一开始另写了一份简化定位，结果真实页面上"找不到下一页"，
  //    而同一个页面上 act 的 click 就能点到 —— 两套实现必然分叉。
  async function autoResolveTarget(step) {
    if (step.target != null && step.target !== "") return { target: Number(step.target), label: "" };
    const q = step.text || step.label || "";
    if (!q) return { target: null, label: "" };
    const r = await act({ action: "find", text: String(q) });
    if (!r || !r.ok || !r.data) return { target: null, label: String(q) };
    const m = /\[(\d+)\]/.exec(String(r.data));
    return m ? { target: Number(m[1]), label: String(q) } : { target: null, label: String(q) };
  }

  async function autoStep(step) {
    const op = String((step && (step.op || step.type)) || "click").toLowerCase();

    if (op === "wait" || op === "sleep") {
      const ms = Number(step.ms) > 0 ? Number(step.ms) : Number(step.seconds) > 0 ? Number(step.seconds) * 1000 : 500;
      await autoSleep(ms);
      return { ok: true, msg: `等待 ${ms}ms` };
    }

    // 需要定位目标的步骤：先 find（与手动操作同一条路径），再 act
    if (["click", "fill", "type", "select", "check", "extract"].includes(op)) {
      const { target, label } = await autoResolveTarget(step);
      if (target == null) {
        return {
          ok: false,
          msg: `找不到要操作的「${label || step.selector || "元素"}」（用的就是手动操作那套定位）`,
        };
      }
      const mapped = { action: op, target };
      if (op === "fill" || op === "type") {
        mapped.value = step.value == null ? "" : String(step.value);
        if (step.human !== undefined) mapped.human = step.human === true || step.human === "true";
        if (step.speed !== undefined) mapped.speed = step.speed;
      }
      if (op === "select") mapped.value = step.option == null ? step.value : step.option;
      if (op === "check") mapped.value = !(step.value === false || step.value === "false");
      const r = await act(mapped);
      return r && typeof r === "object"
        ? { ...r, msg: r.msg || `${op}「${label}」` }
        : { ok: false, msg: "页面没有响应这个步骤" };
    }

    // 不需要目标的步骤：直接翻译成标准动作
    if (op === "press" || op === "key") {
      const r = await act({ action: "press", key: String(step.key || step.text || "ArrowRight") });
      return r && typeof r === "object" ? r : { ok: false, msg: "按键没生效" };
    }
    if (op === "scroll") {
      const r = await act({
        action: "scroll",
        direction: String(step.dir || step.direction || "down"),
        amount: Number(step.amount) > 0 ? Number(step.amount) : undefined,
      });
      return r && typeof r === "object" ? r : { ok: false, msg: "滚动没生效" };
    }
    if (op === "navigate") {
      const r = await act({ action: "navigate", url: String(step.url || "") });
      return r && typeof r === "object" ? r : { ok: false, msg: "跳转没生效" };
    }
    if (op === "screenshot") {
      const r = await act({ action: "screenshot" });
      return r && typeof r === "object" ? r : { ok: false, msg: "截图失败" };
    }
    return { ok: false, msg: `不认识的步骤：${op}` };
  }

  // 停止条件：present / absent / disabled（按钮变灰后 find 就找不到了）/ nochange
  async function autoUntilMet(until, iter, sig, prevSig) {
    if (!until || typeof until !== "object") return false;
    const op = String(until.op || until.type || "").toLowerCase();
    if (op === "nochange") return iter >= 2 && sig === prevSig;
    if (op === "absent" || op === "present" || op === "disabled") {
      const q = until.text || until.label || "";
      if (!q) return false;
      const r = await act({ action: "find", text: String(q) });
      const found = !!(r && r.ok && r.data);
      if (op === "present") return found;
      // absent 与 disabled 都表示"这个按钮找不到 / 不可操作了"
      return !found;
    }
    return false;
  }

  async function automate(spec) {
    const s = spec && typeof spec === "object" ? spec : {};
    const steps = Array.isArray(s.steps) ? s.steps.filter((x) => x && typeof x === "object") : [];
    if (!steps.length) {
      return {
        ok: false,
        msg: "automate 需要 steps（要循环做什么）",
        hint: '例如 {"action":"automate","repeat":3,"steps":[{"op":"click","text":"继续"},{"op":"wait","ms":2000}]}',
      };
    }
    const repeat = Math.max(1, Math.min(AUTOMATE_MAX_ITER, Number(s.repeat) > 0 ? Math.round(Number(s.repeat)) : 1));
    const intervalMs = Math.max(0, Math.min(20000, Number(s.intervalMs) >= 0 ? Number(s.intervalMs) : 300));
    const maxMs = Math.max(1000, Math.min(AUTOMATE_MAX_MS, Number(s.maxMs) > 0 ? Number(s.maxMs) : 120000));
    const until = s.until && typeof s.until === "object" ? s.until : null;

    const startedAt = Date.now();
    const log = [];
    let iterations = 0;
    let stoppedBy = "repeat";
    let failStreak = 0;
    let prevSig = pageSignature();
    const push = (m) => {
      if (log.length < 60) log.push(m);
    };

    try {
      for (let i = 1; i <= repeat; i++) {
        if (Date.now() - startedAt > maxMs) {
          stoppedBy = "timeout";
          break;
        }
        const sig = pageSignature();
        // 注意：autoUntilMet 是 async 的，必须 await —— 忘记 await 会得到"永远为真"的 Promise，
        // 表现就是第 1 轮就判停、0 轮结束（踩过一次）。
        if (until && (await autoUntilMet(until, i, sig, prevSig))) {
          stoppedBy = "until:" + String(until.op || until.type || "");
          break;
        }
        prevSig = sig;
        iterations = i;
        let roundOk = false;
        for (const step of steps) {
          if (Date.now() - startedAt > maxMs) {
            stoppedBy = "timeout";
            break;
          }
          let r;
          try {
            r = await autoStep(step);
          } catch (err) {
            r = { ok: false, msg: String((err && err.message) || err) };
          }
          push(`#${i} ${r.ok ? "✓" : "✗"} ${r.msg || ""}`);
          if (r.ok) roundOk = true;
        }
        if (stoppedBy === "timeout") break;
        if (!roundOk) {
          failStreak++;
          if (failStreak >= AUTOMATE_FAIL_LIMIT) {
            stoppedBy = "stepFailed";
            break;
          }
        } else {
          failStreak = 0;
        }
        if (intervalMs) await autoSleep(intervalMs);
      }
      if (iterations >= repeat && stoppedBy === "repeat" && until) stoppedBy = "repeat(未满足停止条件)";
    } catch (err) {
      stoppedBy = "error";
      push("异常：" + String((err && err.message) || err));
    }

    const elapsedMs = Date.now() - startedAt;
    const result = {
      ok: true,
      msg: `自动化任务结束：跑了 ${iterations} 轮（约 ${Math.round(elapsedMs / 1000)} 秒，停止原因 ${stoppedBy}）`,
      iterations,
      stoppedBy,
      elapsedMs,
      log,
      pageHint: {
        title: document.title,
        url: location.href,
        scrollY: Math.round(window.scrollY),
        scrollHeight: document.body ? document.body.scrollHeight : 0,
      },
    };

    // 关键一步：**由页面直接通知 SW**"自动化任务结束"，SW 会唤醒 AI 去检查现状并接着干。
    // 放在页面里发（而不是靠侧栏 await），这样即使侧栏在跑的过程中被关掉/切走，也一定唤醒。
    if (s.taskId) {
      try {
        chrome.runtime.sendMessage({
          type: "defer:fired",
          taskId: s.taskId,
          reason: `自动化任务「${s.name || "未命名"}」结束：跑了 ${iterations} 轮，停止原因 ${stoppedBy}`,
        });
      } catch (_) {}
    }
    return result;
  }

  globalThis.__aiCtl = { snapshot, act, banner, armDefer, disarmDefer, automate };
})();
