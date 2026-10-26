// 站点更新到 0.4.5（含描述文案）—— 只在本地用（站点不进仓库推送）
//
// 用法： node test/_site-bump-045.mjs

import { readFileSync, writeFileSync } from "node:fs";

const VER = "0.4.5";
const DATE = "2026-10-26";
const SIZE = "880 KB"; // dist/qingniao-0.4.5.zip = 900,672 字节
const ZIP = (v) => `https://github.com/wangyemen/qingniao/releases/download/v${v}/qingniao-${v}.zip`;
const MIRROR = (v) => `https://ghproxy.net/${ZIP(v)}`;

let n = 0;
const sub = (t, from, to, label) => {
  if (!t.includes(from)) {
    console.error("!! 没找到锚点：" + label);
    return t;
  }
  n++;
  return t.split(from).join(to);
};

// ---------------- index.html ----------------
let idx = readFileSync("qingniao.gt.tc/index.html", "utf8");

// ① 描述文案：把这一版新增的能力写进去（网页描述 + 首屏导语）
idx = sub(
  idx,
  `<meta name="description" content="青鸟是一个 Chrome / Edge 侧边栏 AI 助手：能读当前页面、会点击填写、可挂后台任务等条件满足后自动续跑，多工作区互不干扰。来自 https://github.com/wangyemen/qingniao。" />`,
  `<meta name="description" content="青鸟是一个 Chrome / Edge 侧边栏 AI 助手：能读当前页面、会点击填写、可挂后台任务等条件满足后自动续跑；多工作区互不干扰，还能自己开新标签页去查资料、按元素编号跑自动化循环、记住你附的截图；技能市场分官方与用户两个来源（支持扩展内投稿）。来自 https://github.com/wangyemen/qingniao。" />`,
  "meta description"
);
idx = sub(
  idx,
  `  一个 Chrome / Edge 侧边栏 AI 助手。和普通"聊天框"不同的是，<b>它真的会动手</b>：<br />
  替你读页面、替你点按填写、替你在后台等条件，办完了回来告诉你。`,
  `  一个 Chrome / Edge 侧边栏 AI 助手。和普通"聊天框"不同的是，<b>它真的会动手</b>：<br />
  替你读页面、替你点按填写、替你在后台等条件、替你把重复动作交给程序跑循环，办完了回来告诉你。<br />
  <b>v${VER}</b>：多标签页协作（自己开新页去查、再回来接着干）、技能市场分<b>官方 / 用户</b>两个来源、提问附带的截图直接显示。`,
  "tagline"
);

// ② 版本号（最新版相关的每一处）
idx = sub(idx, '<span class="badge"><i></i><b>v0.4.4</b></span>', `<span class="badge"><i></i><b>v${VER}</b></span>`, "badge");
idx = sub(
  idx,
  `<a class="btn btn-primary" href="${ZIP("0.4.4")}">
        <svg viewBox="0 0 24 24"><path d="M12 4v11M7 10l5 5 5-5M5 20h14"/></svg>
        直接下载 v0.4.4
      </a>
      <a class="btn" href="${MIRROR("0.4.4")}">`,
  `<a class="btn btn-primary" href="${ZIP(VER)}">
        <svg viewBox="0 0 24 24"><path d="M12 4v11M7 10l5 5 5-5M5 20h14"/></svg>
        直接下载 v${VER}
      </a>
      <a class="btn" href="${MIRROR(VER)}">`,
  "hero buttons"
);
idx = sub(idx, '<div class="ver-note">v0.4.4</div>', `<div class="ver-note">v${VER}</div>`, "ver-note");
idx = sub(idx, "当前版本 v0.4.4 · Manifest V3", `当前版本 v${VER} · Manifest V3`, "sp-modal-sub");
idx = sub(idx, '<p class="sp-ver">0.4.4</p>', `<p class="sp-ver">${VER}</p>`, "sp-ver");
idx = sub(idx, "完整日志（0.1.0 → 0.4.4）在这里", "完整日志（0.1.0 → 0.4.5）在这里", "changelog 链接文案");
idx = sub(idx, "看完整更新日志（0.1.0 → 0.4.4）", "看完整更新日志（0.1.0 → 0.4.5）", "底部链接文案");
idx = sub(idx, '<div style="margin-top:4px">青鸟 · 浏览器助手 <span class="pill-tag">v0.4.4</span></div>', `<div style="margin-top:4px">青鸟 · 浏览器助手 <span class="pill-tag">v${VER}</span></div>`, "页脚版本");

// 下载主卡
idx = sub(idx, '<h3>🚀 最新版 <span class="ver">v0.4.4</span></h3>', `<h3>🚀 最新版 <span class="ver">v${VER}</span></h3>`, "下载主卡标题");
idx = sub(
  idx,
  `<a class="btn btn-primary" href="${ZIP("0.4.4")}">
          <svg viewBox="0 0 24 24"><path d="M12 4v11M7 10l5 5 5-5M5 20h14"/></svg>
          直接下载 v0.4.4（866 KB）
        </a>`,
  `<a class="btn btn-primary" href="${ZIP(VER)}">
          <svg viewBox="0 0 24 24"><path d="M12 4v11M7 10l5 5 5-5M5 20h14"/></svg>
          直接下载 v${VER}（${SIZE}）
        </a>`,
  "下载主卡按钮"
);
idx = sub(idx, `<a class="btn btn-sm" style="margin-top:8px" href="${MIRROR("0.4.4")}">`, `<a class="btn btn-sm" style="margin-top:8px" href="${MIRROR(VER)}">`, "下载主卡镜像按钮");
idx = sub(idx, "当前版本 0.4.4 · 2026-10-26", `当前版本 ${VER} · ${DATE}`, "下载主卡 meta");

// 按版本下载：插入 0.4.5 卡片，0.4.4 降为历史
idx = sub(
  idx,
  `        <article class="dl-ver latest">
          <div class="dl-ver-head"><b>v0.4.4</b><span class="pill-tag">最新</span></div>`,
  `        <article class="dl-ver latest">
          <div class="dl-ver-head"><b>v${VER}</b><span class="pill-tag">最新</span></div>
          <p class="meta">${SIZE} · ${DATE} · 两个市场并列+分页、插件内投稿与 editToken、截图显示、草稿与关页误报修复</p>
          <div class="dl-actions">
            <a class="btn btn-primary btn-sm" href="${ZIP(VER)}">下载 .zip</a>
            <a class="btn btn-sm" href="${MIRROR(VER)}">国内加速</a>
            <button class="copy-btn" type="button" data-copy="${ZIP(VER)}">复制直链</button>
          </div>
        </article>

        <article class="dl-ver">
          <div class="dl-ver-head"><b>v0.4.4</b></div>`,
  "按版本卡片"
);

// 其它加速线路的示例版本
idx = sub(idx, "下面以最新版 v0.4.4 为例，点按钮直接下：", `下面以最新版 v${VER} 为例，点按钮直接下：`, "镜像示例文案");
for (const prefix of ["https://ghproxy.net/", "https://gh-proxy.com/", "https://ghfast.top/", "https://gh.llkk.cc/"]) {
  idx = sub(idx, `<a class="btn btn-sm" href="${prefix}${ZIP("0.4.4")}">下载 v0.4.4</a>`, `<a class="btn btn-sm" href="${prefix}${ZIP(VER)}">下载 v${VER}</a>`, "镜像行 " + prefix);
}

// 版本一览表
idx = sub(
  idx,
  `          <tr>
            <td class="mono">0.4.4</td>
            <td class="now">最新</td>`,
  `          <tr>
            <td class="mono">${VER}</td>
            <td class="now">最新</td>
            <td><a class="btn btn-primary btn-sm" href="${ZIP(VER)}">下载 v${VER}</a></td>
          </tr>
          <tr>
            <td class="mono">0.4.4</td>
            <td>自定义请求头、Anthropic 兼容、多标签页协作</td>`,
  "版本表"
);

// 时间线：插入 0.4.5，0.4.4 降为历史
idx = sub(
  idx,
  `      <li class="current">
        <div class="vhead"><b>0.4.4</b><time>2026-10-26</time><span class="pill-tag">最新</span></div>`,
  `      <li class="current">
        <div class="vhead"><b>${VER}</b><time>${DATE}</time><span class="pill-tag">最新</span></div>
        <ul>
          <li>新增：技能市场分 <strong>官方市场 / 用户市场</strong>两个<strong>并列</strong>的来源（同一套展示框架，顶部切换），
            两边都做了<strong>分页</strong>；用户市场的条目明确标「用户投稿 · 已过审」，装好后<strong>默认停用</strong>；</li>
          <li>新增：<strong>插件内投稿</strong>（投稿只允许从扩展发起）—— 提交后进入待审核，
            <strong>editToken 直接显示在该技能的卡片上</strong>（可复制 / 查状态 / 撤回投稿），只有提交者看得到，更新重装都不会丢；</li>
          <li>修复：<strong>提问附带的截图不显示</strong>（附件在建工作区时被丢掉的顺序 bug）→ 现在显示缩略图、<strong>点一下看大图</strong>、
            base64 存本地、<strong>随会话删除一起消失</strong>；</li>
          <li>修复：<strong>发过的内容切页又回到输入框</strong>（草稿）→ 发送后清草稿、未归属页面按标签页分开存、失败会把文字放回；</li>
          <li>修复：<strong>关掉临时标签页后一直报「目标标签页已经被关闭了」</strong> → 关页后自动换目标，校验改为重读+重试；</li>
          <li>修复：<strong>开了自动执行还弹「执行/取消」</strong> → 自动模式直接进入执行中，待确认还支持跨面板实例；</li>
          <li>修复：<strong>导入技能时元数据跑进正文</strong>（编辑框里能看到 name/title 那几行）→ 导入与保存都剥干净；
            导出改用 <code>&lt;!-- qingniao-skill --&gt;</code> 注释装元数据（Markdown 渲染不会显示它），老格式继续兼容，
            并加了「清理元数据残留」按钮。</li>
        </ul>
      </li>

      <li>
        <div class="vhead"><b>0.4.4</b><time>2026-10-26</time></div>`,
  "首页时间线"
);

writeFileSync("qingniao.gt.tc/index.html", idx, "utf8");

// ---------------- changelog.html ----------------
let cl = readFileSync("qingniao.gt.tc/changelog.html", "utf8");
cl = sub(cl, "完整更新日志：0.1.0 → 0.4.4", "完整更新日志：0.1.0 → 0.4.5", "changelog meta");
cl = sub(cl, "当前最新：<b>0.4.4</b>（2026-10-26）。", `当前最新：<b>${VER}</b>（${DATE}）。`, "changelog hero");
cl = sub(
  cl,
  `<a class="btn btn-primary" href="${ZIP("0.4.4")}">
        <svg viewBox="0 0 24 24"><path d="M12 4v11M7 10l5 5 5-5M5 20h14"/></svg>
        直接下载 v0.4.4（866 KB）
      </a>
      <a class="btn" href="${MIRROR("0.4.4")}">`,
  `<a class="btn btn-primary" href="${ZIP(VER)}">
        <svg viewBox="0 0 24 24"><path d="M12 4v11M7 10l5 5 5-5M5 20h14"/></svg>
        直接下载 v${VER}（${SIZE}）
      </a>
      <a class="btn" href="${MIRROR(VER)}">`,
  "changelog hero 按钮"
);
cl = sub(
  cl,
  `<a class="btn btn-primary" href="${ZIP("0.4.4")}">
        <svg viewBox="0 0 24 24"><path d="M12 4v11M7 10l5 5 5-5M5 20h14"/></svg>
        直接下载最新版 v0.4.4
      </a>`,
  `<a class="btn btn-primary" href="${ZIP(VER)}">
        <svg viewBox="0 0 24 24"><path d="M12 4v11M7 10l5 5 5-5M5 20h14"/></svg>
        直接下载最新版 v${VER}
      </a>`,
  "changelog 底部按钮"
);
cl = sub(cl, '<div style="margin-top:4px">青鸟 · 浏览器助手 <span class="pill-tag">v0.4.4</span></div>', `<div style="margin-top:4px">青鸟 · 浏览器助手 <span class="pill-tag">v${VER}</span></div>`, "changelog 页脚");
cl = sub(cl, `releases/download/v0.4.4/qingniao-0.4.4.zip">下载最新版`, `releases/download/v${VER}/qingniao-${VER}.zip">下载最新版`, "changelog 页脚下载");

cl = sub(
  cl,
  `      <li class="current">
        <div class="vhead"><b>0.4.4</b><time>2026-10-26</time><span class="pill-tag">最新</span>`,
  `      <li class="current">
        <div class="vhead"><b>${VER}</b><time>${DATE}</time><span class="pill-tag">最新</span>
          <span class="vdl">
            <a class="btn btn-primary btn-sm" href="${ZIP(VER)}">下载 ${VER}</a>
            <a class="btn btn-sm" href="${MIRROR(VER)}">国内加速</a>
          </span>
        </div>
        <ul>
          <li>新增：<strong>技能市场分成两个并列的市场</strong>（同一套展示框架，顶部两个按钮切换）
            <ul>
              <li><strong>官方市场</strong>：仍旧走 GitHub（随仓库发版）；</li>
              <li><strong>用户市场</strong>：走官网接口，只返回<strong>审核通过</strong>的条目，卡片标「用户投稿 · 已过审」，装好后<strong>默认停用</strong>；</li>
              <li>两边都做了<strong>分页</strong>（每页 12 条 + 页码条）。</li>
            </ul>
          </li>
          <li>新增：<strong>插件内投稿</strong>（投稿只允许从扩展发起）
            <ul>
              <li>「我的技能」点「投稿到用户市场」→ 提交后进入待审核，通过才上架；</li>
              <li>拿到的 <strong>editToken 直接显示在该技能的卡片上</strong>（可复制 / 查状态 / 撤回投稿），
                只有提交者看得到，技能更新、重装都不会弄丢；</li>
              <li>投稿的 id 有<strong>唯一性保护</strong>：别人占用的会被拒；官方技能的 id 是保留名，用了会被拒并提示改名；
                插件安装时遇到同名不同来源的技能，会装成 <code>&lt;id&gt;-user</code>，不再默默覆盖。</li>
            </ul>
          </li>
          <li>修复：<strong>提问里附带的截图不显示</strong>
            <ul>
              <li>根因：在"还没有工作区的页面"上贴图后发消息时，附件在读取之前就被清空了 → 图根本没进消息；</li>
              <li>现在图片以 base64 存进那条消息并在气泡里显示<strong>缩略图</strong>，<strong>点一下看大图</strong>，
                重开侧栏仍在，<strong>随会话删除一起消失</strong>。</li>
            </ul>
          </li>
          <li>修复：<strong>发过的内容切页又出现在输入框</strong>（草稿）—— 发送后清草稿、未归属页面按标签页分开存、发送失败会把文字放回；没发送的草稿仍然保留；</li>
          <li>修复：<strong>关掉临时标签页后一直报「目标标签页已经被关闭了」</strong> —— 关页后自动换目标，动作前校验改为"重读 + 重试"，文案区分"读不到"与"确实被关"；</li>
          <li>修复：<strong>开了自动执行，切换标签页这类调用还弹「执行/取消」等你点</strong> —— 自动模式直接进入执行中，且待确认支持跨面板实例；</li>
          <li>修复：<strong>导入技能时元数据会跑进正文</strong>（编辑框里能看见 name/title 那几行，再保存就变两份）→ 导入与保存都剥干净；
            导出改用 <code>&lt;!-- qingniao-skill … --&gt;</code> HTML 注释装元数据（任何 Markdown 渲染都不显示它，
            也不会被语法吃掉），导入同时兼容新老格式并容忍 BOM / 空行 / CRLF / <code>...</code> 收尾；
            设置页加了「清理元数据残留」按钮。</li>
        </ul>
      </li>

      <li>
        <div class="vhead"><b>0.4.4</b><time>2026-10-26</time>`,
  "changelog 时间线"
);
writeFileSync("qingniao.gt.tc/changelog.html", cl, "utf8");

// 用户市场页页脚版本
let mk = readFileSync("qingniao.gt.tc/market.html", "utf8");
mk = sub(mk, '<span class="pill-tag">v0.4.4</span>', `<span class="pill-tag">v${VER}</span>`, "market 页脚");
writeFileSync("qingniao.gt.tc/market.html", mk, "utf8");

console.log(`站点已更新到 ${VER}：共 ${n} 处替换`);