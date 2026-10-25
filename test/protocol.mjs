// 协议层的纯 Node 测试（不需要浏览器）：动作解析、tab 参数、多行内容
//
// 用法： node test/protocol.mjs

import { extractAction, formatElements } from "../lib/protocol.js";

let pass = 0,
  fail = 0;
const check = (name, ok, extra) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra !== undefined ? "  [" + extra + "]" : ""}`);
  ok ? pass++ : fail++;
};

// ---------- ① 多行内容：模型写了"字面换行"（JSON 非法）也要能用 ----------
const literalNl =
  "好的。\n```action\n" + '{"action":"fill","target":3,"value":"# 标题一\n## 标题二"}' + "\n```";
const a1 = extractAction(literalNl);
check("字面换行的动作能解析（不再判失败）", !a1.parseError && !!a1.data, a1.reason || "");
check(
  "换行被正确保留成 \\n（两行）",
  a1.data && a1.data.value === "# 标题一\n## 标题二",
  JSON.stringify(a1.data && a1.data.value)
);

const escapedNl =
  "好的。\n```action\n" + '{"action":"fill","target":3,"value":"# 标题一\\n## 标题二\\n\\n正文"}' + "\n```";
const a2 = extractAction(escapedNl);
check(
  "转义写法 \\n 照样正确（含空行的 3 行）",
  a2.data && a2.data.value === "# 标题一\n## 标题二\n\n正文",
  JSON.stringify(a2.data && a2.data.value)
);

// 字符串外的换行不能被破坏（那是合法的 JSON 空白）
const pretty =
  "```action\n" +
  '{\n  "action": "fill",\n  "target": 3,\n  "value": "一行\\n二行"\n}\n' +
  "```";
const a3 = extractAction(pretty);
check("美化过的多行 JSON 不受影响", a3.data && a3.data.value === "一行\n二行", JSON.stringify(a3.data && a3.data.value));

// ---------- ② tab 参数 ----------
const t1 = extractAction('```action\n{"action":"click","target":5,"tab":1691460332}\n```');
check("tab 为数字 → 归一成数字", t1.data && t1.data.tab === 1691460332, JSON.stringify(t1.data && t1.data.tab));
const t2 = extractAction('```action\n{"action":"extract","tab":"1691460332"}\n```');
check("tab 为数字字符串 → 也认", t2.data && t2.data.tab === 1691460332, JSON.stringify(t2.data && t2.data.tab));
const t3 = extractAction('```action\n{"action":"extract","tab":"网易云课堂"}\n```');
check("tab 为标题片段 → 保留文本", t3.data && t3.data.tab === "网易云课堂", JSON.stringify(t3.data && t3.data.tab));
const t4 = extractAction('```action\n{"action":"extract"}\n```');
check("不写 tab → 不带该字段（走默认/粘性）", t4.data && t4.data.tab === undefined, JSON.stringify(t4.data && t4.data.tab));

// ---------- ③ newtab / closetab ----------
const n1 = extractAction('```action\n{"action":"newtab","url":"https://example.com","active":false}\n```');
check("newtab 是合法动作", n1.data && n1.data.action === "newtab" && n1.data.url === "https://example.com", JSON.stringify(n1.data));
check("newtab 的 active 被归一成布尔", n1.data && n1.data.active === false, JSON.stringify(n1.data && n1.data.active));
const n2 = extractAction('```action\n{"action":"closetab","tab":1691460332}\n```');
check("closetab 是合法动作", n2.data && n2.data.action === "closetab" && n2.data.tab === 1691460332, JSON.stringify(n2.data));

// ---------- ④ 元素列表里的同名提示（AI 靠它挑对编号） ----------
const rendered = formatElements([
  { i: 0, tag: "button", label: "下一页", sameLabel: "1/3", pos: "上部", near: "页头导航（干扰项）" },
  { i: 2, tag: "button", label: "下一页", sameLabel: "2/3", pos: "中部", near: "上一页 下一页 点击次数：0" },
]);
check(
  "同名元素标出「同名 2/3 · 页面中部 · 附近…」",
  /同名 2\/3/.test(rendered) && /页面中部/.test(rendered) && /附近/.test(rendered),
  rendered.split("\n")[1]
);

console.log(`\n===== protocol 结果：${pass}/${pass + fail} 通过 =====`);
process.exit(fail ? 1 : 0);