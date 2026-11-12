// 站点更新到 0.4.6（版本锚点 + 浏览器弹窗接管的文案）—— 只在本地用（站点不进仓库推送）
//
// 用法： node test/_site-bump-046.mjs
// 改完跑一次 node test/site-check.mjs 看标签有没有配平、直链是否成对。
//
// ⚠️ 全部是**字面锚点**替换：任何一个锚点没命中都会打「!! 没找到锚点」，
//    宁可漏改，也不要凭正则把上一版的下载链接一起改掉（历史版本卡片必须留在页面上）。

import { readFileSync, writeFileSync } from "node:fs";

const VER = "0.4.6";
const PREV = "0.4.5";
const DATE = "2026-11-11"; // 与 version.txt 的 released 一致（侧栏更新弹窗显示的就是它）
const SIZE = "908 KB"; // dist/qingniao-0.4.6.zip = 930,038 字节
const ZIP = (v) => `https://github.com/wangyemen/qingniao/releases/download/v${v}/qingniao-${v}.zip`;
const MIRROR = (v) => `https://ghproxy.net/${ZIP(v)}`;

let n = 0;
const miss = [];
const sub = (t, from, to, label) => {
  if (!t.includes(from)) {
    miss.push(label);
    console.error("!! 没找到锚点：" + label);
    return t;
  }
  n++;
  return t.split(from).join(to);
};

// ---------------- index.html ----------------
let idx = readFileSync("qingniao.gt.tc/index.html", "utf8");

// ① 描述文案：把这一版新增的能力写进 meta 与首屏导语
idx = sub(
  idx,
  `按元素编号跑自动化循环、记住你附的截图。技能市场分官方（GitHub）与用户（官网）两个来源`,
  `按元素编号跑自动化循环、记住你附的截图，连浏览器自己弹出的 alert / confirm / prompt 都归它管（不再把页面卡死）。技能市场分官方（GitHub）与用户（官网）两个来源`,
  "meta description"
);
idx = sub(
  idx,
  `<meta property="og:description" content="替你读页面、点按填写、跑腿办事的浏览器 AI 助手。多工作区、后台任务、技能市场。" />`,
  `<meta property="og:description" content="替你读页面、点按填写、跑腿办事的浏览器 AI 助手。多工作区、后台任务、技能市场，连浏览器弹窗也能替你处理掉。" />`,
  "og description"
);
idx = sub(
  idx,
  `      <b>v0.4.5</b>：多标签页协作（自己开新页去查、再回来接着干）、技能市场分<b>官方 / 用户</b>两个来源、
      提问附带的截图直接显示出来。`,
  `      <b>v${VER}</b>：浏览器自己弹出的 <b>alert / confirm / prompt / 「离开站点？」</b>也归侧栏管 ——
      看得见内容、不再把页面卡住，AI 还能<b>先预设答案再去点</b>。`,
  "tagline"
);

// ② 版本号（每一处"最新版"相关的）
idx = sub(idx, `<span class="badge"><i></i><b>v${PREV}</b></span>`, `<span class="badge"><i></i><b>v${VER}</b></span>`, "badge");
idx = sub(
  idx,
  `<a class="btn btn-primary" href="${ZIP(PREV)}">
        <svg viewBox="0 0 24 24"><path d="M12 4v11M7 10l5 5 5-5M5 20h14"/></svg>
        直接下载 v${PREV}
      </a>
      <a class="btn" href="${MIRROR(PREV)}">`,
  `<a class="btn btn-primary" href="${ZIP(VER)}">
        <svg viewBox="0 0 24 24"><path d="M12 4v11M7 10l5 5 5-5M5 20h14"/></svg>
        直接下载 v${VER}
      </a>
      <a class="btn" href="${MIRROR(VER)}">`,
  "hero buttons"
);
idx = sub(idx, `<div class="ver-note">v${PREV}</div>`, `<div class="ver-note">v${VER}</div>`, "ver-note");
idx = sub(idx, `当前版本 v${PREV} · Manifest V3`, `当前版本 v${VER} · Manifest V3`, "sp-modal-sub");

// 侧栏"青鸟已更新"弹窗的复刻内容：跟着这一版走
idx = sub(
  idx,
  `<p class="sp-ver">${PREV}</p>
                <ul>
                  <li>技能目录与更新检查改为 <strong>GitHub API 优先（实时）</strong>，镜像只做兜底；</li>
                  <li>原因：jsDelivr 对 <code>@main</code> 这类分支地址会缓存最多 12 小时；</li>
                  <li>拉取失败时自动重试一次。</li>
                </ul>`,
  `<p class="sp-ver">${VER}</p>
                <ul>
                  <li>修复：<strong>浏览器弹窗（alert / confirm / prompt / 离开确认）把侧栏卡死</strong>；</li>
                  <li>新增：接管分三档（只在 AI 操控那一页时接管 / 始终接管 / 不接管），改完<strong>不用刷新页面</strong>；</li>
                  <li>新增：AI 可以<strong>先预设答案再去点</strong> —— confirm 答「确定」、prompt 填指定文字。</li>
                </ul>`,
  "sp-ver 弹窗复刻"
);
idx = sub(idx, "（0.1.0 → 0.4.4 全量，取自仓库里的", `（0.1.0 → ${VER} 全量，取自仓库里的`, "pv-note 全量范围");
idx = sub(idx, "完整日志（0.1.0 → 0.4.5）在这里", `完整日志（0.1.0 → ${VER}）在这里`, "changelog 链接文案");
idx = sub(idx, "看完整更新日志（0.1.0 → 0.4.5）", `看完整更新日志（0.1.0 → ${VER}）`, "底部链接文案");
idx = sub(
  idx,
  `<div style="margin-top:4px">青鸟 · 浏览器助手 <span class="pill-tag">v${PREV}</span></div>`,
  `<div style="margin-top:4px">青鸟 · 浏览器助手 <span class="pill-tag">v${VER}</span></div>`,
  "页脚版本"
);
idx = sub(idx, `本页最后整理：<span id="site-date">2026-10-25</span>`, `本页最后整理：<span id="site-date">${DATE}</span>`, "site-date");

// 下载主卡
idx = sub(idx, `<h3>🚀 最新版 <span class="ver">v${PREV}</span></h3>`, `<h3>🚀 最新版 <span class="ver">v${VER}</span></h3>`, "下载主卡标题");
idx = sub(
  idx,
  `<a class="btn btn-primary" href="${ZIP(PREV)}">
          <svg viewBox="0 0 24 24"><path d="M12 4v11M7 10l5 5 5-5M5 20h14"/></svg>
          直接下载 v${PREV}（880 KB）
        </a>`,
  `<a class="btn btn-primary" href="${ZIP(VER)}">
          <svg viewBox="0 0 24 24"><path d="M12 4v11M7 10l5 5 5-5M5 20h14"/></svg>
          直接下载 v${VER}（${SIZE}）
        </a>`,
  "下载主卡按钮"
);
idx = sub(
  idx,
  `<a class="btn btn-sm" style="margin-top:8px" href="${MIRROR(PREV)}">`,
  `<a class="btn btn-sm" style="margin-top:8px" href="${MIRROR(VER)}">`,
  "下载主卡镜像按钮"
);
idx = sub(idx, `当前版本 ${PREV} · 2026-10-26`, `当前版本 ${VER} · ${DATE}`, "下载主卡 meta");

// 按版本下载：0.4.5 先降为历史，再插 0.4.6 新卡
idx = sub(
  idx,
  `        <article class="dl-ver latest">
          <div class="dl-ver-head"><b>v${PREV}</b><span class="pill-tag">最新</span></div>`,
  `        <article class="dl-ver">
          <div class="dl-ver-head"><b>v${PREV}</b></div>`,
  "上一版卡片降级"
);
idx = sub(
  idx,
  `        <article class="dl-ver">
          <div class="dl-ver-head"><b>v${PREV}</b></div>`,
  `        <article class="dl-ver latest">
          <div class="dl-ver-head"><b>v${VER}</b><span class="pill-tag">最新</span></div>
          <p class="meta">${SIZE} · ${DATE} · 浏览器弹窗接管（alert/confirm/prompt/离开确认）、dialog 动作与预设答案、注入超时兜底</p>
          <div class="dl-actions">
            <a class="btn btn-primary btn-sm" href="${ZIP(VER)}">下载 .zip</a>
            <a class="btn btn-sm" href="${MIRROR(VER)}">国内加速</a>
            <button class="copy-btn" type="button" data-copy="${ZIP(VER)}">复制直链</button>
          </div>
        </article>

        <article class="dl-ver">
          <div class="dl-ver-head"><b>v${PREV}</b></div>`,
  "按版本卡片"
);

// 其它加速线路的示例版本
idx = sub(idx, `下面以最新版 v${PREV} 为例，点按钮直接下：`, `下面以最新版 v${VER} 为例，点按钮直接下：`, "镜像示例文案");
for (const prefix of ["https://ghproxy.net/", "https://gh-proxy.com/", "https://ghfast.top/", "https://gh.llkk.cc/"]) {
  idx = sub(
    idx,
    `<a class="btn btn-sm" href="${prefix}${ZIP(PREV)}">下载 v${PREV}</a>`,
    `<a class="btn btn-sm" href="${prefix}${ZIP(VER)}">下载 v${VER}</a>`,
    "镜像行 " + prefix
  );
}

// 版本一览表：0.4.5 那行去掉"最新"，插 0.4.6 新行
idx = sub(
  idx,
  `          <tr>
            <td class="mono">${PREV}</td>
            <td class="now">最新</td>
            <td><a class="btn btn-primary btn-sm" href="${ZIP(PREV)}">下载 v${PREV}</a></td>
          </tr>`,
  `          <tr>
            <td class="mono">${VER}</td>
            <td class="now">最新</td>
            <td><a class="btn btn-primary btn-sm" href="${ZIP(VER)}">下载 v${VER}</a></td>
          </tr>
          <tr>
            <td class="mono">${PREV}</td>
            <td>官方 / 用户两个市场并列分页、插件内投稿与 editToken、截图显示与草稿修复</td>
            <td><a class="btn btn-primary btn-sm" href="${ZIP(PREV)}">下载 v${PREV}</a></td>
          </tr>`,
  "版本表"
);

// ③ 特性区：新增"浏览器弹窗也归侧栏管"一张卡（放在「可靠性与自愈」之后）
idx = sub(
  idx,
  `      <article class="card">
        <h3><span class="ico">🧩</span>技能市场：把"怎么干"写成说明书</h3>`,
  `      <article class="card">
        <h3><span class="ico">🗯️</span>浏览器弹窗也归侧栏管</h3>
        <p><code>alert</code> / <code>confirm</code> / <code>prompt</code> / 「离开站点？」这几种框是<b>浏览器画的、不在网页里</b>：
        元素列表、无障碍树都读不到它，而且它一出现会把整页 JS <b>按住</b> —— 以前的表现就是"AI 点了个按钮，侧栏像死掉"。</p>
        <ul>
          <li><b>看得见</b>：弹了什么、被答成了什么，一律记进页面里的一本账，随每次读页面交给 AI（也写进对话，压缩记忆后仍在）；</li>
          <li><b>不卡住</b>：接管之后立刻同步一个答案放行，同时在页面左下角给你一条提示 —— 不是悄悄吃掉；</li>
          <li><b>能控制</b>：AI 可以<b>先预设答案再去点</b> —— confirm 答「确定」、prompt 填指定文字，用完即失效；</li>
          <li>三档时机（设置页，改完<b>不用刷新页面</b>）：只在 AI 操控那一页时接管（默认，你自己浏览不受打扰）/ 始终接管 / 不接管；</li>
          <li>默认答案保守：<code>confirm</code> 与 <code>prompt</code> 默认答<b>「取消」</b>，不会替你点「确定删除」这类按钮；</li>
          <li>跟「自动执行」是一条线：开了自动执行就没有任何"等你点"的环节 —— 这一轮期间（模型思考、重试、压缩记忆都可能超过 90 秒）会持续给这一页续上接管心跳；</li>
          <li>兜底：读页面 / 执行动作的注入调用都带超时，真被什么东西按住时侧栏<b>不再干等</b>，而是如实告诉你是谁需要你点一下。</li>
        </ul>
      </article>

      <article class="card">
        <h3><span class="ico">🧩</span>技能市场：把"怎么干"写成说明书</h3>`,
  "特性卡：浏览器弹窗"
);

// 后台任务的等待条件补上新的一种
idx = sub(
  idx,
  `<li><code>defer</code> 动作支持等待<b>定时 / 元素出现 / 文字出现 / 视频播完</b>，满足后自动唤醒继续；</li>`,
  `<li><code>defer</code> 动作支持等待<b>定时 / 元素出现 / 文字出现 / 视频播完 / 浏览器弹窗弹出</b>，满足后自动唤醒继续；</li>`,
  "defer 条件列表"
);

// 「下载前请知道」补两条真实的边界（不吹成万能）
idx = sub(
  idx,
  `        <li>只有来自 GitHub 仓库或本页所列线路的包才是本项目发布的，别用来源不明的"青鸟"安装包。</li>`,
  `        <li>只有来自 GitHub 仓库或本页所列线路的包才是本项目发布的，别用来源不明的"青鸟"安装包。</li>
        <li><strong>浏览器弹窗</strong>能接管的是 alert / confirm / prompt / 离开确认这四种；<strong>文件选择框、打印框</strong>是系统级弹窗，浏览器没有给扩展关闭它们的 API —— 真卡在那儿时青鸟会停下来告诉你"需要你点一下"，不会一直干等；</li>
        <li>接管钩子随扩展注入：<strong>安装 / 更新之前就已经打开的页面</strong>不带钩子，刷新那一页才有。</li>`,
  "下载前请知道"
);

// 首页时间线：0.4.5 降级 + 插入 0.4.6
idx = sub(
  idx,
  `<div class="vhead"><b>${PREV}</b><time>2026-10-26</time><span class="pill-tag">最新</span></div>`,
  `<div class="vhead"><b>${PREV}</b><time>2026-10-26</time></div>`,
  "时间线：上一版去最新标"
);
idx = sub(
  idx,
  `      <li class="current">
        <div class="vhead"><b>${PREV}</b><time>2026-10-26</time></div>`,
  `      <li class="current">
        <div class="vhead"><b>${VER}</b><time>${DATE}</time><span class="pill-tag">最新</span></div>
        <ul>
          <li>修复：<strong>浏览器自己的弹窗（alert / confirm / prompt / 「离开站点？」）把侧栏卡死</strong> ——
            这种框不在网页内部，侧栏既看不见它也点不到它，它一出现还把整页 JS 按住
            （用户原话："这个不在网页内部，是浏览器的弹窗，侧边栏没有控制"）；</li>
          <li>新增：<strong>弹窗接管三档</strong>（只在 AI 操控那一页时接管 / 始终接管 / 不接管），设置页改完<strong>不用刷新页面</strong>就生效；</li>
          <li>新增：AI 侧的 <code>{"action":"dialog"}</code> 动作 —— 看这页弹过什么、各自被答成了什么、接管到底有没有生效，
            并且能<strong>先预设答案再去点</strong>（confirm 答「确定」、prompt 填指定文字，一次有效）；</li>
          <li>新增：<code>defer</code> 可以把"等页面弹出某个框"挂成后台任务；自动化循环每轮把弹窗记录写进执行日志；</li>
          <li>改进：读页面 / 执行动作的注入调用<strong>全部加超时兜底</strong>（侧栏不再干等），
            开自动执行时这一轮期间持续续住接管心跳 —— <strong>没有任何"等你点一下"的环节</strong>；</li>
          <li>说明：文件选择框、打印框这类系统级弹窗接管不到；扩展更新前就打开的页面要刷新一次才带钩子。
            <strong>端到端测试 92/92 通过</strong>（新增 14 条专测浏览器弹窗）。</li>
        </ul>
      </li>

      <li>
        <div class="vhead"><b>${PREV}</b><time>2026-10-26</time></div>`,
  "首页时间线插入新版"
);

writeFileSync("qingniao.gt.tc/index.html", idx, "utf8");

// ---------------- changelog.html ----------------
let cl = readFileSync("qingniao.gt.tc/changelog.html", "utf8");
cl = sub(cl, `完整更新日志：0.1.0 → ${PREV}`, `完整更新日志：0.1.0 → ${VER}`, "changelog meta");
cl = sub(cl, `当前最新：<b>${PREV}</b>（2026-10-26）。`, `当前最新：<b>${VER}</b>（${DATE}）。`, "changelog hero");
cl = sub(
  cl,
  `<a class="btn btn-primary" href="${ZIP(PREV)}">
        <svg viewBox="0 0 24 24"><path d="M12 4v11M7 10l5 5 5-5M5 20h14"/></svg>
        直接下载 v${PREV}（880 KB）
      </a>
      <a class="btn" href="${MIRROR(PREV)}">`,
  `<a class="btn btn-primary" href="${ZIP(VER)}">
        <svg viewBox="0 0 24 24"><path d="M12 4v11M7 10l5 5 5-5M5 20h14"/></svg>
        直接下载 v${VER}（${SIZE}）
      </a>
      <a class="btn" href="${MIRROR(VER)}">`,
  "changelog hero 按钮"
);
cl = sub(
  cl,
  `<a class="btn btn-primary" href="${ZIP(PREV)}">
        <svg viewBox="0 0 24 24"><path d="M12 4v11M7 10l5 5 5-5M5 20h14"/></svg>
        直接下载最新版 v${PREV}
      </a>`,
  `<a class="btn btn-primary" href="${ZIP(VER)}">
        <svg viewBox="0 0 24 24"><path d="M12 4v11M7 10l5 5 5-5M5 20h14"/></svg>
        直接下载最新版 v${VER}
      </a>`,
  "changelog 底部按钮"
);
cl = sub(
  cl,
  `<div style="margin-top:4px">青鸟 · 浏览器助手 <span class="pill-tag">v${PREV}</span></div>`,
  `<div style="margin-top:4px">青鸟 · 浏览器助手 <span class="pill-tag">v${VER}</span></div>`,
  "changelog 页脚"
);
cl = sub(cl, `releases/download/v${PREV}/qingniao-${PREV}.zip">下载最新版`, `releases/download/v${VER}/qingniao-${VER}.zip">下载最新版`, "changelog 页脚下载");

cl = sub(
  cl,
  `<div class="vhead"><b>${PREV}</b><time>2026-10-26</time><span class="pill-tag">最新</span>`,
  `<div class="vhead"><b>${PREV}</b><time>2026-10-26</time>`,
  "changelog 时间线：上一版去最新标"
);
cl = sub(
  cl,
  `      <li class="current">
        <div class="vhead"><b>${PREV}</b><time>2026-10-26</time>`,
  `      <li class="current">
        <div class="vhead"><b>${VER}</b><time>${DATE}</time><span class="pill-tag">最新</span>
          <span class="vdl">
            <a class="btn btn-primary btn-sm" href="${ZIP(VER)}">下载 ${VER}</a>
            <a class="btn btn-sm" href="${MIRROR(VER)}">国内加速</a>
          </span>
        </div>
        <ul>
          <li>修复：<strong>浏览器原生弹窗（alert / confirm / prompt / 「离开站点？」）把侧栏卡死</strong>（用户反馈：这种框不在网页内部，侧栏根本没有控制）
            <ul>
              <li>根因两条：① 它是<strong>浏览器画的模态框，不在 DOM 里</strong> —— 元素列表 / 无障碍树 / extract 全都读不到它，AI 等于瞎着；
                ② 它一出现把整页主线程<strong>按住</strong>，注入调用永不返回 → 侧栏看起来就是"点了个按钮之后死了"；</li>
              <li>现在 <code>content/dialog-hook.js</code>（页面世界 · document_start · 所有框架）把这四种框换成可控版本：
                <strong>内容照记</strong>（记在页面上的一本账，谁读页面都拿得到）、<strong>给人看</strong>（页面左下角提示条：弹了什么、被答成了什么）、
                <strong>立刻同步一个答案</strong>放行（页面不再卡住）；</li>
              <li>接管时机分三档（设置页 →「浏览器弹窗」，<strong>改完不用刷新页面</strong>就生效）：
                <code>只在 AI 操控那一页时接管</code>（默认，你自己浏览时不受打扰）/ <code>始终接管</code> / <code>不接管</code>；</li>
              <li>侧栏与 AI 现在<strong>能控制</strong>它：
                <ul>
                  <li>新动作 <code>{"action":"dialog"}</code> 看这页弹过什么、各自被答成了什么、接管到底有没有生效；</li>
                  <li><strong>先预设再点</strong>：<code>{"action":"dialog","op":"arm","accept":true}</code> 让下一个 confirm 答「确定」；
                    <code>{"op":"arm","kind":"prompt","value":"文字"}</code> 让下一个 prompt 填这段（一次有效，30 秒过期）；</li>
                  <li><code>defer</code> 可以把"等页面弹出某个框"挂成后台任务；</li>
                  <li>弹窗过程会写进对话（【浏览器弹窗】段落）：AI 不会再把"有个框被答掉了"当成"点了没反应"而反复重点同一个按钮。</li>
                </ul>
              </li>
              <li>默认答案保守取向：confirm 与 prompt <strong>默认答「取消」</strong>，不会替你点「确定删除」（可在设置里改）；</li>
              <li>心跳与自动执行：AI 每读一次页面 / 每执行一步就续一下，本轮结束后<strong>再留 20 秒收尾窗口</strong>
                （"点完一秒后页面才弹出『保存成功』"其实属于这一步的尾巴）；开了自动执行，这一轮期间（模型思考、5 次重试、
                换模型、压缩记忆都可能超过 90 秒）持续续心跳，框架侧窗口<strong>只延长、绝不剪短</strong> ——
                自动执行下没有任何"等你点一下"的环节；</li>
              <li>兜底：所有读页面 / 执行动作的注入调用都加了超时（4~30 秒），<strong>页面真被什么东西按住时侧栏不再干等</strong>，
                会如实说"这页没回应，八成是浏览器弹窗（文件选择框 / 打印框这类接管不到的）要你点一下"；
                自动化任务每轮把弹窗记录写进执行日志，整页卡住会以 <code>stuck</code> 原因停下汇报，而不是空转到超时；</li>
              <li>说明：接管只装在 http(s) 与 file 页面上；<strong>扩展安装 / 更新之前就已打开的页面不带钩子</strong>（刷新那一页才有），
                读到这种情况 AI 会直接告诉你，而不是瞎猜框里写了什么。</li>
            </ul>
          </li>
          <li>验证：端到端测试 <strong>92/92 通过</strong>，其中新增 14 条专测浏览器弹窗
            （alert 不卡页面、账本可见、confirm 默认取消、arm 后答确定、prompt 填字、离开确认放行与交还、改设置即刻生效、心跳只延长不剪短）。</li>
        </ul>
      </li>

      <li>
        <div class="vhead"><b>${PREV}</b><time>2026-10-26</time>`,
  "changelog 时间线插入新版"
);
writeFileSync("qingniao.gt.tc/changelog.html", cl, "utf8");

// 用户市场页页脚版本
let mk = readFileSync("qingniao.gt.tc/market.html", "utf8");
mk = sub(mk, `<span class="pill-tag">v${PREV}</span>`, `<span class="pill-tag">v${VER}</span>`, "market 页脚");
writeFileSync("qingniao.gt.tc/market.html", mk, "utf8");

console.log(`站点已更新到 ${VER}：共 ${n} 处替换${miss.length ? "，失败 " + miss.length + " 处：" + miss.join(" | ") : ""}`);
process.exitCode = miss.length ? 1 : 0;
