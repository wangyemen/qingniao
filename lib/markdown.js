// ===== 轻量 Markdown 渲染器（无外部依赖，MV3 CSP 友好）=====
// 安全原则：先把模型输出整体 HTML 转义，再生成我们自己的标签 —— 模型输出里的
// <script>/<img onerror> 一律变成纯文本，不存在注入面。
//
// 支持：标题 h1-h6、段落、换行、粗体/斜体/删除线/行内代码、链接（仅 http(s)/mailto）、
// 有序/无序列表（可嵌套）、任务列表、引用（可嵌套）、水平线、表格（含对齐）、
// 围栏代码块（带语言标签 + 复制按钮）。

const ESC_MAP = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ESC_MAP[c]);
}

// ---------- 行内 ----------

const LINK_RE = /^https?:\/\/[^\s<>"')]+$/i;

function inline(src) {
  let s = esc(src);

  // 行内代码先抽出来（内部不再做任何替换，避免 `*x*` 被当斜体）
  const codes = [];
  s = s.replace(/`([^`\n]+)`/g, (_, code) => {
    codes.push(code);
    return `\u0000C${codes.length - 1}\u0000`;
  });

  // 链接 [text](url "title")
  s = s.replace(/\[([^\]\n]+)\]\(([^)\s]+)(?:\s+&quot;[^)"]*&quot;)?\)/g, (m, text, url) => {
    if (!LINK_RE.test(url.replace(/&amp;/g, "&"))) return m;
    return `<a href="${url}" target="_blank" rel="noopener noreferrer">${text}</a>`;
  });

  // 裸链接自动成链（跳过已经是 a href 的部分：我们只匹配尚不在标签内的 http）
  s = s.replace(/(^|[\s(（])(https?:\/\/[^\s<)）]+)/g, (m, pre, url) => {
    if (/href=.$/.test(pre)) return m;
    return `${pre}<a href="${url}" target="_blank" rel="noopener noreferrer">${url}</a>`;
  });

  // 粗体 / 删除线 / 斜体 / 下划线斜体
  s = s.replace(/\*\*\*([^*\n]+)\*\*\*/g, "<strong><em>$1</em></strong>");
  s = s.replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/(^|[^\\])\b__([^_\n]+)__\b/g, "$1<strong>$2</strong>");
  s = s.replace(/~~([^~\n]+)~~/g, "<del>$1</del>");
  s = s.replace(/(^|[^*\w])\*([^*\n]+)\*(?!\*)/g, "$1<em>$2</em>");
  s = s.replace(/(^|[^_\w])_([^_\n]+)_(?!_)/g, "$1<em>$2</em>");

  // 行内代码还原
  s = s.replace(/\u0000C(\d+)\u0000/g, (_, i) => `<code>${codes[Number(i)]}</code>`);
  return s;
}

// ---------- 表格 ----------

const TABLE_SEP_RE = /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/;

function splitRow(line) {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|")) s = s.slice(0, -1);
  // 支持 \| 转义竖线
  const cells = [];
  let cur = "";
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "\\" && s[i + 1] === "|") {
      cur += "|";
      i++;
    } else if (c === "|") {
      cells.push(cur.trim());
      cur = "";
    } else {
      cur += c;
    }
  }
  cells.push(cur.trim());
  return cells;
}

function renderTable(header, sep, rows) {
  const aligns = splitRow(sep).map((c) => {
    const left = c.startsWith(":");
    const right = c.endsWith(":");
    if (left && right) return "center";
    if (right) return "right";
    if (left) return "left";
    return "";
  });
  const th = splitRow(header)
    .map((c, i) => {
      const a = aligns[i] ? ` style="text-align:${aligns[i]}"` : "";
      return `<th${a}>${inline(c)}</th>`;
    })
    .join("");
  const body = rows
    .map((r) => {
      const tds = splitRow(r)
        .map((c, i) => {
          const a = aligns[i] ? ` style="text-align:${aligns[i]}"` : "";
          return `<td${a}>${inline(c)}</td>`;
        })
        .join("");
      return `<tr>${tds}</tr>`;
    })
    .join("");
  return `<div class="md-table-wrap"><table><thead><tr>${th}</tr></thead><tbody>${body}</tbody></table></div>`;
}

// ---------- 列表 ----------

const UL_RE = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;
const TASK_RE = /^\[([ xX])\]\s+(.*)$/;

// 递归渲染列表块；返回 [html, 消耗到的行号]
function renderList(lines, start, indent) {
  const first = UL_RE.exec(lines[start]);
  const ordered = /\d/.test(first[2]);
  const startNum = ordered ? parseInt(first[2], 10) : 1;
  const items = [];
  let i = start;
  let loose = false;

  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      // 空行后如果还是同类列表项就继续（loose list），否则结束
      const next = lines[i + 1];
      if (next && UL_RE.test(next) && UL_RE.exec(next)[1].length >= indent) {
        loose = true;
        i++;
        continue;
      }
      break;
    }
    const m = UL_RE.exec(line);
    if (!m) break;
    const ind = m[1].length;
    const isOrdered = /\d/.test(m[2]);
    if (ind < indent) break;
    if (ind > indent) {
      // 这一项开始一个子列表，交给递归
      const [subHtml, next] = renderList(lines, i, ind);
      if (items.length) items[items.length - 1].children.push(subHtml);
      else items.push({ text: "", children: [subHtml] });
      i = next;
      continue;
    }
    if (isOrdered !== ordered) break; // 不同列表类型：交给上层当新列表
    // 收集该项续行（缩进比标记更深的普通文本）
    let text = m[3];
    i++;
    const extra = [];
    while (i < lines.length) {
      const l = lines[i];
      if (!l.trim()) break;
      if (UL_RE.test(l)) break;
      if (/^\s{2,}\S/.test(l) && l.trim()) {
        extra.push(l.trim());
        i++;
        continue;
      }
      break;
    }
    items.push({ text: extra.length ? text + "\n" + extra.join("\n") : text, children: [] });
  }

  const li = items
    .map((it) => {
      let task = "";
      let text = it.text;
      const tm = TASK_RE.exec(text.trim());
      if (tm) {
        const done = tm[1].toLowerCase() === "x";
        task = `<span class="md-task${done ? " done" : ""}">${done ? "✓" : ""}</span>`;
        text = tm[2];
      }
      const body = text
        .split("\n")
        .map((l) => inline(l))
        .join("<br>");
      return `<li${task ? ' class="md-task-item"' : ""}>${task}${body}${it.children.join("")}</li>`;
    })
    .join("");

  const tag = ordered ? "ol" : "ul";
  const attr = ordered && startNum !== 1 ? ` start="${startNum}"` : "";
  return [`<${tag}${attr}${loose ? ' class="md-loose"' : ""}>${li}</${tag}>`, i];
}

// ---------- 纯文本导出（复制用）----------
// 把 Markdown 还原成"人读得懂、粘到富文本编辑器里也干净"的纯文本：
// 去掉 # ** ` 等标记，链接摊平成"文字 (网址)"，表格变制表符分隔。
export function markdownToPlainText(src) {
  let text = String(src == null ? "" : src).replace(/\r\n?/g, "\n");
  const out = [];

  const lines = text.split("\n");
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    // 围栏代码块：保留代码内容，去掉围栏标记
    const fence = /^\s*(```+|~~~+)\s*([\w+#.-]*)\s*$/.exec(line);
    if (fence) {
      const mark = fence[1][0];
      const buf = [];
      i++;
      while (i < lines.length && !new RegExp("^\\s*" + mark + "{3,}\\s*$").test(lines[i])) {
        buf.push(lines[i]);
        i++;
      }
      if (i < lines.length) i++;
      if (buf.length) out.push(buf.join("\n"));
      continue;
    }

    // 表格 → 每行用制表符分隔
    if (line.includes("|") && i + 1 < lines.length && TABLE_SEP_RE.test(lines[i + 1]) && lines[i + 1].includes("-")) {
      const rows = [line];
      i += 2;
      while (i < lines.length && lines[i].includes("|") && lines[i].trim()) {
        rows.push(lines[i]);
        i++;
      }
      for (const r of rows) {
        const cells = splitRow(r).map((c) => inlinePlain(c));
        out.push(cells.join("\t"));
      }
      continue;
    }

    // 引用 → 去掉 > 前缀
    if (/^\s*>/.test(line)) {
      const buf = [];
      while (i < lines.length && (/^\s*>/.test(lines[i]) || (buf.length && lines[i].trim()))) {
        buf.push(lines[i].replace(/^\s*>\s?/, ""));
        i++;
      }
      out.push(buf.join("\n"));
      continue;
    }

    // 水平线 → 丢掉
    if (/^\s*([-*_])\s*(\1\s*){2,}$/.test(line)) {
      i++;
      continue;
    }

    // 标题 → 去掉 # 号
    const h = /^\s{0,3}#{1,6}\s+(.*?)\s*#*\s*$/.exec(line);
    if (h) {
      out.push(inlinePlain(h[1]));
      i++;
      continue;
    }

    // 列表 → 保留项目符号（纯文本里这是结构信息）
    const li = UL_RE.exec(line);
    if (li) {
      out.push(line.replace(UL_RE, "$1$2 $3"));
      i++;
      continue;
    }

    out.push(inlinePlain(line));
    i++;
  }

  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

// 行内标记 → 纯文本
function inlinePlain(src) {
  let s = String(src == null ? "" : src);
  s = s.replace(/!\[([^\]\n]*)\]\([^)]*\)/g, "$1"); // 图片 → alt
  s = s.replace(/\[([^\]\n]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, "$1 ($2)"); // 链接 → 文字 (网址)
  s = s.replace(/`([^`\n]+)`/g, "$1"); // 行内代码
  s = s.replace(/\*\*\*([^*\n]+)\*\*\*/g, "$1");
  s = s.replace(/\*\*([^*\n]+)\*\*/g, "$1");
  s = s.replace(/__([^_\n]+)__/g, "$1");
  s = s.replace(/~~([^~\n]+)~~/g, "$1");
  s = s.replace(/\*([^*\n]+)\*/g, "$1");
  s = s.replace(/_([^_\n]+)_/g, "$1");
  return s;
}

// ---------- 代码块 ----------

function renderCode(code, lang) {
  const l = (lang || "").trim();
  const label = l ? `<span class="md-code-lang">${esc(l)}</span>` : "";
  return (
    `<div class="md-code"><div class="md-code-head">${label}` +
    `<button class="md-copy" type="button">复制</button></div>` +
    `<pre><code>${esc(code)}</code></pre></div>`
  );
}

// ---------- 主入口 ----------

export function renderMarkdown(src) {
  const text = String(src == null ? "" : src).replace(/\r\n?/g, "\n");
  const lines = text.split("\n");
  const out = [];
  let i = 0;

  while (i < lines.length) {
    const raw = lines[i];
    const line = raw;

    // 空行
    if (!line.trim()) {
      i++;
      continue;
    }

    // 围栏代码块（未闭合也照常输出，流式时不会闪成正文）
    const fence = /^\s*(```+|~~~+)\s*([\w+#.-]*)\s*$/.exec(line);
    if (fence) {
      const mark = fence[1][0];
      const buf = [];
      i++;
      while (i < lines.length && !new RegExp("^\\s*" + mark + "{3,}\\s*$").test(lines[i])) {
        buf.push(lines[i]);
        i++;
      }
      if (i < lines.length) i++; // 跳过结束围栏
      out.push(renderCode(buf.join("\n"), fence[2]));
      continue;
    }

    // 水平线
    if (/^\s*([-*_])\s*(\1\s*){2,}$/.test(line)) {
      out.push("<hr>");
      i++;
      continue;
    }

    // 标题
    const h = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (h) {
      const lv = Math.min(h[1].length, 4); // 侧边栏窄，h5/h6 降到 h4
      out.push(`<h${lv} class="md-h">${inline(h[2])}</h${lv}>`);
      i++;
      continue;
    }

    // 表格：当前行像表头 + 下一行是分隔行
    if (line.includes("|") && i + 1 < lines.length && TABLE_SEP_RE.test(lines[i + 1]) && lines[i + 1].includes("-")) {
      const header = line;
      const sep = lines[i + 1];
      i += 2;
      const rows = [];
      while (i < lines.length && lines[i].includes("|") && lines[i].trim()) {
        rows.push(lines[i]);
        i++;
      }
      out.push(renderTable(header, sep, rows));
      continue;
    }

    // 引用（可嵌套）
    if (/^\s*>/.test(line)) {
      const buf = [];
      while (i < lines.length && (/^\s*>/.test(lines[i]) || (buf.length && lines[i].trim()))) {
        buf.push(lines[i].replace(/^\s*>\s?/, ""));
        i++;
      }
      out.push(`<blockquote class="md-quote">${renderMarkdown(buf.join("\n"))}</blockquote>`);
      continue;
    }

    // 列表
    if (UL_RE.test(line)) {
      const [html, next] = renderList(lines, i, UL_RE.exec(line)[1].length);
      out.push(html);
      i = next;
      continue;
    }

    // 段落：连续非空行合并，行内换行保留为 <br>
    const buf = [];
    while (i < lines.length && lines[i].trim() && !UL_RE.test(lines[i]) && !/^\s*(```|~~~|>|#{1,6}\s)/.test(lines[i])) {
      // 段落里出现的表格分隔行不算段落中断
      buf.push(lines[i]);
      i++;
    }
    if (buf.length) {
      out.push(`<p>${buf.map((l) => inline(l)).join("<br>")}</p>`);
    } else {
      i++; // 兜底防死循环
    }
  }

  return out.join("");
}
