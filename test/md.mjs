// Markdown 渲染器单元检查（node test/md.mjs）
import { renderMarkdown, markdownToPlainText } from "../lib/markdown.js";

let pass = 0;
let fail = 0;
function check(name, cond, detail) {
  if (cond) {
    pass++;
    console.log("PASS  " + name + (detail ? "  [" + String(detail).slice(0, 120) + "]" : ""));
  } else {
    fail++;
    console.log("FAIL  " + name + (detail ? "  [" + String(detail).slice(0, 300) + "]" : ""));
  }
}

// 1. 标题
const h = renderMarkdown("# 一级\n\n## 二级\n###### 六级");
check("标题 h1/h2/h6", /<h1 class="md-h">一级<\/h1>/.test(h) && /<h2 class="md-h">二级<\/h2>/.test(h) && /<h4 class="md-h">六级<\/h4>/.test(h), h);

// 2. 无序列表（含嵌套）
const ul = renderMarkdown("- 苹果\n- 香蕉\n  - 小米蕉\n- 橙子");
check("无序列表 + 嵌套", (ul.match(/<li>/g) || []).length === 4 && /<ul><li>苹果<\/li><li>香蕉<ul>/.test(ul), ul);

// 3. 有序列表
const ol = renderMarkdown("1. 第一步\n2. 第二步\n3. 第三步");
check("有序列表", /<ol><li>第一步<\/li><li>第二步<\/li><li>第三步<\/li><\/ol>/.test(ol), ol);

// 4. 有序列表起点
const ol3 = renderMarkdown("3. 三\n4. 四");
check("有序列表保留起始序号", /start="3"/.test(ol3), ol3);

// 5. 表格（含对齐）
const table = renderMarkdown("| 名称 | 价格 | 说明 |\n|:---|---:|:---:|\n| 苹果 | 3.5 | 红 |\n| 梨 | 4 | 黄 |");
check(
  "表格：thead/tbody/单元格",
  /<table><thead><tr><th style="text-align:left">名称<\/th>/.test(table) &&
    (table.match(/<td/g) || []).length === 6 &&
    /text-align:right/.test(table) &&
    /text-align:center/.test(table),
  table
);

// 6. 代码块
const code = renderMarkdown("说明：\n\n```js\nconst a = 1 < 2;\n```\n");
check(
  "围栏代码块 + 语言 + 复制按钮",
  /md-code-lang">js</.test(code) && /md-copy/.test(code) && /const a = 1 &lt; 2;/.test(code),
  code
);

// 7. 未闭合代码块（流式）
const codeOpen = renderMarkdown("```python\nprint(1)");
check("未闭合代码块也能渲染", /<pre><code>print\(1\)<\/code><\/pre>/.test(codeOpen), codeOpen);

// 8. 行内：粗体/斜体/删除线/行内代码
const inl = renderMarkdown("这是 **粗体**、*斜体*、~~删除~~ 和 `code`。");
check(
  "行内格式",
  /<strong>粗体<\/strong>/.test(inl) && /<em>斜体<\/em>/.test(inl) && /<del>删除<\/del>/.test(inl) && /<code>code<\/code>/.test(inl),
  inl
);

// 9. 行内代码里的 * 不被当斜体
const inl2 = renderMarkdown("使用 `a*b*c` 这样写");
check("行内代码内的 * 保持原样", /<code>a\*b\*c<\/code>/.test(inl2), inl2);

// 10. 链接
const link = renderMarkdown("见 [文档](https://example.com/a?b=1) 了解");
check("链接 + 安全属性", /<a href="https:\/\/example.com\/a\?b=1" target="_blank" rel="noopener noreferrer">文档<\/a>/.test(link), link);

// 11. 危险协议被拒绝
const bad = renderMarkdown("[x](javascript:alert(1))");
check("javascript: 链接不生成 a 标签", !/<a /.test(bad), bad);

// 12. HTML 注入被转义
const inj = renderMarkdown('<img src=x onerror="alert(1)"> <script>alert(2)</script>');
check("HTML 被转义（无注入面）", !/<img|<script/.test(inj) && /&lt;script&gt;/.test(inj), inj);

// 13. 引用
const quote = renderMarkdown("> 引用一行\n> 引用二行\n\n正文");
check("引用块", /<blockquote class="md-quote"><p>引用一行<br>引用二行<\/p><\/blockquote>/.test(quote), quote);

// 14. 水平线
check("水平线", /<hr>/.test(renderMarkdown("上面\n\n---\n\n下面")));

// 15. 任务列表
const task = renderMarkdown("- [x] 已完成\n- [ ] 未完成");
check("任务列表", /md-task done/.test(task) && /md-task"/.test(task) && !/\[x\]/.test(task), task);

// 16. 段落内的单换行保留为 <br>
check("段落内换行 → <br>", /<p>第一行<br>第二行<\/p>/.test(renderMarkdown("第一行\n第二行")));

// 17. 多种块混排不串行
const mixed = renderMarkdown("## 结果\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n- x\n- y\n\n```\ncode\n```\n\n结束");
check(
  "混排：标题+表格+列表+代码+段落",
  /<h2/.test(mixed) && /<table>/.test(mixed) && /<ul>/.test(mixed) && /<pre>/.test(mixed) && /<p>结束<\/p>/.test(mixed),
  mixed.replace(/\n/g, " ").slice(0, 200)
);

// 18. 空输入
check("空输入不抛错", renderMarkdown("") === "" && renderMarkdown(null) === "", renderMarkdown(null));

// 19. 表格单元格内的行内格式
const t2 = renderMarkdown("| 项 | 值 |\n|---|---|\n| **粗** | `x` |");
check("表格内支持行内格式", /<strong>粗<\/strong>/.test(t2) && /<code>x<\/code>/.test(t2), t2);

// 20. 不出现 undefined/NaN
const all = [h, ul, ol, table, code, inl, quote, task, mixed, t2].join("");
check("输出无 undefined/NaN", !/undefined|NaN/.test(all));

// ===== 纯文本导出（复制用）=====
// 21. 标题/强调/行内代码的标记都去掉
const p1 = markdownToPlainText("## 标题\n\n正文有 **粗体**、*斜体*、~~删除~~ 和 `code`。");
check(
  "纯文本：去掉标题/强调/行内代码标记",
  p1.includes("标题") &&
    p1.includes("正文有 粗体、斜体、删除 和 code") &&
    !/[#*`~]/.test(p1),
  JSON.stringify(p1)
);

// 22. 链接摊平成"文字 (网址)"
const p2 = markdownToPlainText("见 [文档](https://example.com/a?b=1) 了解");
check("纯文本：链接摊平为 文字 (网址)", /文档 \(https:\/\/example\.com\/a\?b=1\)/.test(p2), JSON.stringify(p2));

// 23. 表格 → 制表符分隔
const p3 = markdownToPlainText("| 名称 | 价格 |\n|---|---|\n| 苹果 | 3.5 |");
check("纯文本：表格变制表符分隔", p3.includes("名称\t价格") && p3.includes("苹果\t3.5"), JSON.stringify(p3));

// 24. 代码块保留代码、去掉围栏
const p4 = markdownToPlainText("说明\n\n```js\nconst a = 1;\n```");
check("纯文本：代码块保留内容去掉围栏", p4.includes("const a = 1;") && !/```/.test(p4), JSON.stringify(p4));

// 25. 列表保留项目符号、引用去掉 >、水平线丢弃
const p5 = markdownToPlainText("> 引用行\n\n- 项目一\n- 项目二\n\n---\n\n结尾");
check(
  "纯文本：列表保留符号/引用去>/水平线丢弃",
  p5.includes("- 项目一") && p5.includes("引用行") && !p5.includes(">") && !p5.includes("---"),
  JSON.stringify(p5)
);

// 26. 空输入不抛错
check("纯文本：空输入不抛错", markdownToPlainText("") === "" && markdownToPlainText(null) === "");

console.log(`\n===== Markdown 检查：${pass}/${pass + fail} 通过 =====`);
if (fail) process.exitCode = 1;
