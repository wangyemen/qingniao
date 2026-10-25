// 动作协议：模型输出 ```action {json}``` 代码块来操作页面
// 这里负责解析、描述动作，以及给模型看的协议说明与元素列表格式化

// 支持 ```action / ```json / 无语言标记 的围栏块，以及裸 JSON（含 "action" 字段）
const FENCE_RE = /```(?:action|json)?\s*\n([\s\S]*?)```/;
const BARE_RE = /\{[^{}]*["'“”]action["'“”]\s*[:：][\s\S]*?\}/i;

// 展示用：把动作代码块从正文里去掉（执行过程由操作卡片呈现，正文里再显示一遍只是噪音）。
// 同时处理流式过程中"围栏还没闭合"的半截状态。
export function stripActionFence(text) {
  let s = String(text || "");
  s = s.replace(/```(?:action|json)?\s*\n(?:[^`]|`(?!``))*?```/g, (m) => (/"action"\s*:/.test(m) ? "" : m));
  // 未闭合的尾部动作围栏
  s = s.replace(/```(?:action|json)?\s*\n(?:(?!```)[\s\S])*$/, (m) => (/"action"\s*:/.test(m) ? "" : m));
  return s.replace(/\n{3,}/g, "\n\n").trimEnd();
}

const KNOWN_ACTIONS = new Set([
  "click",
  "fill",
  "select",
  "check",
  "press",
  "scroll",
  "navigate",
  "extract",
  "wait",
  "focus",
  "screenshot",
  "type",
  "find",
  "a11y",
  "switchtab",
  "defer",
  // 自动化任务：重复性动作交给程序跑循环
  "automate",
  "automation",
  "loop",
]);

// 清洗模型手滑写坏的 JSON：中文引号 → 英文引号、全角冒号 → 半角、去掉尾随逗号。
// 只做这几件事，不做通用 JSON 修复（避免把模型的真实意图改坏）。
function repairJson(raw) {
  let s = String(raw || "").trim();
  if (!s) return "";
  // 去掉围栏里可能混入的前后缀文字（模型有时会写 ```json 之外的解释）
  s = s.replace(/^```[a-zA-Z]*\s*/, "").replace(/```\s*$/, "").trim();
  // 中文引号 → 英文引号
  s = s.replace(/[“”„‟″‶]/g, '"').replace(/[‘’‚‛′]/g, "'");
  // 全角冒号 → 半角
  s = s.replace(/：/g, ":");
  // 全角逗号 → 半角
  s = s.replace(/，/g, ",");
  // 尾随逗号（对象/数组末尾）
  s = s.replace(/,\s*([}\]])/g, "$1");
  // 单引号 → 双引号（JSON 不接受单引号）。只在值/键都是单引号时换，
  // 避免破坏字符串内部的撇号（英文缩写 don't 之类）
  if (!/"/.test(s) && /'/.test(s)) {
    s = s.replace(/'([^'\\]*)'/g, '"$1"');
  }
  return s;
}

export function extractAction(text) {
  if (!text) return null;
  let raw = null;
  // 围栏里是不是"像动作"：既要认标准写法，也要认被写坏的引号/冒号
  // （模型手滑写成 {"action"："fill"} 时，不能因为守卫不匹配就整个丢掉）
  const looksLikeAction = (s) => /["'“”]action["'“”]\s*[:：]/i.test(s);
  const fence = FENCE_RE.exec(text);
  if (fence && looksLikeAction(fence[1])) {
    raw = fence[1];
    var blockStart = fence.index;
    var blockEnd = fence.index + fence[0].length;
  } else {
    const bare = BARE_RE.exec(text);
    if (!bare) return null;
    raw = bare[0];
    var blockStart = bare.index;
    var blockEnd = bare.index + bare[0].length;
  }

  let data;
  try {
    data = JSON.parse(raw.trim());
  } catch (e) {
    // 模型常见的 JSON 小毛病：中文引号、尾随逗号、全角冒号、单引号。
    // 这些几乎都是"手滑"而不是"意图不明"，先清洗再试一次，成功就别打扰模型。
    const cleaned = repairJson(raw);
    if (cleaned) {
      try {
        data = JSON.parse(cleaned);
      } catch (_) {
        data = null;
      }
    }
    if (!data) {
      return {
        parseError: true,
        reason: "动作 JSON 解析失败（" + (e && e.message ? e.message : "格式错误") + "）",
        before: text.slice(0, blockStart),
        after: text.slice(blockEnd),
      };
    }
  }
  if (!data || typeof data !== "object") {
    return {
      parseError: true,
      reason: "动作不是一个 JSON 对象",
      before: text.slice(0, blockStart),
      after: text.slice(blockEnd),
    };
  }
  if (!KNOWN_ACTIONS.has(data.action)) {
    return {
      parseError: true,
      reason:
        "动作名 " +
        JSON.stringify(data.action) +
        " 不支持。可用动作：" +
        [...KNOWN_ACTIONS].join(" / "),
      before: text.slice(0, blockStart),
      after: text.slice(blockEnd),
    };
  }
  return {
    data: normalizeAction(data),
    before: text.slice(0, blockStart),
    after: text.slice(blockEnd),
  };
}

function normalizeAction(a) {
  const out = { action: a.action };
  if (a.target !== undefined && a.target !== null && a.target !== "") {
    out.target = Number(a.target);
  }
  if (a.value !== undefined) out.value = a.value;
  if (a.url !== undefined) out.url = String(a.url).trim();
  if (a.key !== undefined) out.key = String(a.key);
  if (a.direction !== undefined) out.direction = String(a.direction);
  if (a.text !== undefined) out.text = String(a.text);
  if (a.query !== undefined) out.query = String(a.query);
  if (a.ms !== undefined) out.ms = Math.min(10000, Math.max(100, Number(a.ms) || 1000));
  if (a.amount !== undefined) out.amount = Math.min(5000, Math.max(100, Number(a.amount) || 600));
  // 后台任务（defer）：条件触发的"等待-唤醒-继续"，不占 API、不烧 token
  if (a.instruction !== undefined) out.instruction = String(a.instruction).slice(0, 2000);
  if (a.until !== undefined) out.until = a.until && typeof a.until === "object" ? { ...a.until } : { type: String(a.until) };
  if (a.timeoutSec !== undefined) {
    out.timeoutSec = Math.min(86400, Math.max(10, Number(a.timeoutSec) || 1800));
  }
  // 自动化任务：把"循环做什么/什么时候停"的字段带过去
  // ⚠️ 这个白名单是**必须**的：漏掉的字段会被丢掉，模型写了也等于没写。
  if (a.name !== undefined) out.name = String(a.name).slice(0, 40);
  if (a.repeat !== undefined) out.repeat = Math.min(500, Math.max(1, Number(a.repeat) || 1));
  if (a.intervalMs !== undefined) out.intervalMs = Math.min(20000, Math.max(0, Number(a.intervalMs) || 0));
  if (a.maxMs !== undefined) out.maxMs = Math.min(600000, Math.max(1000, Number(a.maxMs) || 180000));
  if (a.stallLimit !== undefined) out.stallLimit = Math.min(20, Math.max(1, Number(a.stallLimit) || 3));
  // 变量（页码 1、2、3… 就靠它 + inc/dec）
  if (a.vars && typeof a.vars === "object" && !Array.isArray(a.vars)) {
    const v = {};
    for (const [k, val] of Object.entries(a.vars).slice(0, 12)) {
      if (!/^\w{1,20}$/.test(k)) continue;
      v[k] = Number.isFinite(Number(val)) ? Number(val) : String(val).slice(0, 60);
    }
    if (Object.keys(v).length) out.vars = v;
  }
  if (a.retry && typeof a.retry === "object") {
    out.retry = {
      times: Math.max(0, Math.min(5, Number(a.retry.times) || 0)),
      intervalMs: Math.max(200, Math.min(10000, Number(a.retry.intervalMs) || 1200)),
    };
  }
  if (Array.isArray(a.guard)) {
    out.guard = a.guard
      .filter((g) => g && (g.text || g.target != null))
      .slice(0, 5)
      .map((g) => ({ ...g }));
  }
  if (Array.isArray(a.stopIf)) {
    out.stopIf = a.stopIf
      .filter((g) => g && (g.text || g.target != null))
      .slice(0, 5)
      .map((g) => ({ ...g }));
  }
  if (Array.isArray(a.steps)) {
    out.steps = a.steps
      .filter((s) => s && typeof s === "object")
      .slice(0, 40)
      .map((s) => {
        const step = {};
        for (const k of ["op", "type", "target", "text", "selector", "label", "value", "var", "by", "key", "dir", "direction", "option", "ms", "seconds", "amount", "human", "speed", "state", "optional"]) {
          if (s[k] !== undefined) step[k] = s[k];
        }
        return step;
      });
  }
  // 拟人打字（防检测）：human / speed 也要带过去
  if (a.human !== undefined) out.human = a.human === true || a.human === "true";
  if (a.speed !== undefined) out.speed = ["fast", "normal", "slow"].includes(String(a.speed)) ? String(a.speed) : "normal";
  if (a.minDelay !== undefined) out.minDelay = Math.min(2000, Math.max(5, Number(a.minDelay) || 0));
  if (a.maxDelay !== undefined) out.maxDelay = Math.min(3000, Math.max(10, Number(a.maxDelay) || 0));
  return out;
}

// 人类可读的动作标题（工具卡片用）
export function actionLabel(a) {
  switch (a.action) {
    case "click":
      return `点击元素 #${a.target}`;
    case "fill":
      return `填写元素 #${a.target}`;
    case "select":
      return `选择下拉 #${a.target}`;
    case "check":
      return `勾选元素 #${a.target}`;
    case "press":
      return `按键 ${a.key || "Enter"}`;
    case "scroll":
      return `滚动页面（${a.direction === "up" ? "向上" : "向下"}）`;
    case "navigate":
      return `跳转到 ${short(a.url, 50)}`;
    case "extract":
      return a.target != null ? `提取元素 #${a.target} 文本` : "提取页面文本";
    case "wait":
      return `等待 ${a.ms || 1000}ms`;
    case "focus":
      return `聚焦元素 #${a.target}`;
    case "screenshot":
      return "截取当前页面截图";
    case "type":
      return `逐字输入元素 #${a.target}`;
    case "find":
      return `查找「${short(a.text || a.query || "", 20)}」`;
    case "a11y":
      return a.text || a.query
        ? `查看无障碍树（${short(a.text || a.query || "", 20)}）`
        : "查看无障碍树";
    case "switchtab":
      return `切换标签页 #${a.target}`;
    case "defer": {
      const t = (a.until && (a.until.type || a.until.event)) || "条件";
      const labelMap = {
        "video-ended": "视频播放结束",
        "element-appear": "元素出现",
        "text-appear": "文字出现",
        timeout: "定时",
        event: "事件",
      };
      return `后台任务：等待${labelMap[t] || t}后继续`;
    }
    case "automate":
    case "automation":
    case "loop": {
      const n = a.repeat ? `最多 ${a.repeat} 轮` : "";
      const u = a.until && (a.until.op || a.until.type);
      const stop = u
        ? u === "absent"
          ? "，找不到目标就停"
          : u === "disabled"
            ? "，按钮不可点就停"
            : u === "nochange"
              ? "，页面没变化就停"
              : "，满足条件就停"
        : "";
      return `自动化任务「${short(a.name || "未命名", 16)}」${n}${stop}`;
    }
    default:
      return "执行动作";
  }
}

export function actionDetail(a) {
  const bits = [a.action];
  if (a.target != null) bits.push("target=" + a.target);
  if (a.value !== undefined && a.action !== "extract") {
    bits.push("value=" + short(String(a.value), 30));
  }
  if (a.url) bits.push(short(a.url, 60));
  if (a.key) bits.push("key=" + a.key);
  if (a.text) bits.push(short(a.text, 30));
  if (a.query) bits.push(short(a.query, 30));
  if (a.amount) bits.push("amount=" + a.amount);
  return bits.join(" · ");
}

function short(s, n) {
  s = String(s || "");
  return s.length > n ? s.slice(0, n) + "…" : s;
}

// 元素快照 → 给模型看的紧凑列表
export function formatElements(elements) {
  const lines = [];
  for (const el of elements || []) {
    let line = `[${el.i}] ${el.tag}${el.type ? "(" + el.type + ")" : ""}`;
    if (el.editable) line += "[可输入]";
    if (el.toggle) {
      line += "[勾选框]";
      if (el.checked === true) line += "(已勾选)";
      else if (el.checked === false) line += "(未勾选)";
    }
    // 无标签元素：模型看不见它是什么，只能靠编号猜 —— 明确标出来，提醒它去查
    if (el.nameless) line += "[无标签]";
    if (el.label) line += ` 「${short(el.label, 40)}」`;
    // 同名歧义：同一标签出现多次时，把"同名第几个 · 在页面上/中/下部 · 附近文字"附上，
    // 模型才能挑对那一个（页头/页脚常有同名按钮；没有这个提示就只能猜编号，猜错就点到假按钮）
    const hints = [];
    if (el.sameLabel) hints.push(`同名 ${el.sameLabel}`);
    if (el.pos) hints.push(`页面${el.pos}`);
    if (el.near) hints.push(`附近「${short(el.near, 26)}」`);
    if (hints.length) line += ` （${hints.join(" · ")}）`;
    if (el.value) line += ` 现值="${short(el.value, 24)}"`;
    if (el.href) line += ` -> ${short(el.href, 56)}`;
    if (el.disabled) line += " (禁用)";
    lines.push(line);
  }
  return lines.join("\n");
}

// 给模型的协议说明（控制模式开启时拼进 system prompt）
export const ACTION_PROTOCOL = `
【页面操作协议】
你可以操作当前网页。可交互元素以【可交互元素】编号列表的形式给出。需要操作时：先用一句话说明，然后单独输出一个动作代码块（一次只一个动作）：
\`\`\`action
{"action":"click","target":3}
\`\`\`
可用动作：
- click  {"action":"click","target":N} 点击元素
- fill   {"action":"fill","target":N,"value":"文本"} 填写输入框/文本域/富文本编辑器
- fill(拟人) {"action":"fill","target":N,"value":"文本","human":true,"speed":"normal"} **按真人节奏逐字输入**（慢，但不易被判定成脚本）
- type   {"action":"type","target":N,"value":"文本","speed":"normal"} 逐字输入（模拟真人打字；speed 可 fast/normal/slow）
- select {"action":"select","target":N,"value":"选项文本或值"} 下拉选择
- check  {"action":"check","target":N,"value":true} 勾选/取消勾选（复选框、单选框、开关）
- press  {"action":"press","key":"Enter","target":N} 按键（target 可省，默认焦点元素）
- scroll {"action":"scroll","direction":"down"} 滚动页面（up/down）。可加 "amount":800 指定像素。
  滚的是**当前真正能滚的那个区域**（有些站点内容在内层 div 里，滚 window 没反应），
  滚完会回读确认是否真的移动了；到顶/到底会明确告诉你。
- navigate {"action":"navigate","url":"https://..."} 跳转网址（仅 http/https）
- extract {"action":"extract","target":N} 提取元素文本（省略 target 提取整页摘要）
- find   {"action":"find","text":"匿名发表"} 按文字查找页面元素（返回可直接操作的编号）
- a11y   {"action":"a11y","text":"关键词"} 查看无障碍树（按角色+名称找元素；text 可选，用于只看相关部分）
- switchtab {"action":"switchtab","target":0} 切换到工作区里的另一个标签页（target 是工作区列表里的编号）
- wait   {"action":"wait","ms":1000} 等待后继续（用于页面加载、等动画/请求完成）
- defer  {"action":"defer","until":{"type":"video-ended"},"instruction":"…","timeoutSec":1800} 设置后台任务后**结束本轮**（见下方【后台任务】）
- automate {"action":"automate","name":"…","repeat":N,"steps":[…],"until":{…},"instruction":"…"} **把重复性动作交给程序跑循环**后结束本轮（见下方【自动化任务】）
- screenshot {"action":"screenshot"} 截取当前页面截图（仅会看图的模型；用来确认页面真实状态）
执行结果会以【动作执行结果】连同最新元素列表返回，然后你继续下一步。任务完成时直接用自然语言回答，不要输出动作块。不要虚构编号，只用列表中出现的编号。

【自动化任务 automate（**只要动作要重复，就用它，别自己一步一步点**）】
判据很简单：**同一个动作要做 2 次以上、或"做完等一会儿再做一遍"、或要一直翻到底**，
就用 automate 交给程序跑循环——**你这一轮就此结束可以去休息**，
跑完系统会自动唤醒你，唤醒后**先读页面确认现状**，再执行剩下的任务。

为什么必须用它：
- 你自己循环 = 每一轮都要一次模型请求：慢、贵、容易超时；程序循环零 token。
- 用户离开页面/关掉侧栏，程序照样跑完，跑完一定会唤醒你。

★★★ 定位目标：**用编号（target），不要用文字** ★★★
你刚才看到的元素列表里的编号（例如 [42] button「下一页」），直接写进步骤：
    {"op":"click","target":42}
- 为什么必须用编号：同一段文字在页面上常常有好几处（页头/页脚都有「下一页」），
  按文字找**会点错**（点到那个没用的假按钮上，表现就是"程序在跑但页面没反应"）。
  编号是你亲自挑的那一个，程序用它精确定位；之后每轮还会自动按"结构路径 / 就近"把它找回来。
- 文字（"text"）只作为**兜底与交叉校验**（你手上确实没有编号时才用它）。

步骤 op：
- click  {"op":"click","target":42}            点元素（编号；也可 {"op":"click","text":"下一页"} 兜底）
- fill   {"op":"fill","target":43,"value":"关键词"} 填写（要拟人节奏加 "human":true）
- select {"op":"select","target":44,"value":"价格从低到高"}
- press  {"op":"press","key":"ArrowRight"}     按键（翻页常用 ArrowRight / PageDown / Space）
- scroll {"op":"scroll","dir":"down","amount":800}
- wait   {"op":"wait","ms":1500}               死等（尽量少用）
- waitFor {"op":"waitFor","text":"第 {page} 页 /","ms":8000}  **等条件就绪**（等到出现这段文字，超时才继续）
- waitFor {"op":"waitFor","target":42,"state":"enabled","ms":8000} **等这个元素重新可点**（最可靠的"这一页处理完了"信号）
- inc    {"op":"inc","var":"page"}             变量 +1（页码 1、2、3… 就靠它；dec 是 -1，可加 "by":2）
- set    {"op":"set","var":"page","value":1}

**变量与模板**：vars 里声明的变量（或 inc/dec 改出来的）可以用 {名字} 写进任何 text 里。
翻页的标准写法是"**点下一页 → 先把 page 加 1 → 再等『第 {page} 页』出现**"：
先加再等，等到的才是**下一页**；顺序写反了就是在等当前这一页（立刻满足，等于没等）。
- inc    {"op":"inc","var":"page"}             变量 +1（页码 1、2、3… 就靠它；dec 是 -1，可加 "by":2）
- name        任务名（显示在侧栏横条上）
- repeat      最多循环几轮（1–500）
- intervalMs  每轮之间的间隔毫秒（默认 250）
- vars        变量初值，例如 {"page":1}
- steps       每轮要做的事（必填）
- until       停止条件（每轮开始前检查；满足就提前结束）：
              {"op":"absent","text":"下一页"}  找不到某个按钮了就停（**逐页翻到底最常用**）
              {"op":"disabled","target":42}    这个按钮变灰/不可点了就停（**优先用编号**）
              {"op":"present","text":"已加载完成"} 出现某段文字就停
- guard       可选：出现这些就先点掉再继续（弹窗干扰），例如 [{"text":"关闭"},{"text":"知道了"}]
- stopIf      可选：出现这些就**立刻停下汇报**（被拦住了），例如 [{"text":"请登录"},{"text":"验证码"}]
- retry       可选：单步失败的重试，例如 {"times":2,"intervalMs":1500}（默认 1 次 / 1.2 秒）
- stallLimit  可选：连续几轮页面都没变化就停（默认 3）
- maxMs       总时长上限（默认 180000，最多 600000）
- instruction **跑完唤醒后你要做什么**（必填：先检查什么、再做什么）

现成套路（把 42 换成你在元素列表里看到的真实编号）：
- 有「下一页」按钮、要翻到底（**最常用**）：
  {"action":"automate","name":"翻到最后一页","repeat":200,"vars":{"page":1},
   "steps":[{"op":"click","target":42},
            {"op":"inc","var":"page"},
            {"op":"waitFor","target":42,"state":"enabled","ms":8000}],
   "until":{"op":"disabled","target":42},
   "stallLimit":3,"instruction":"翻完后读页面，汇报一共几页、每页要点"}
  （state:"enabled" = 等"下一页"这个按钮重新可点：点击后它常会短暂变灰防重复提交，
    恢复就说明这一页处理完了。到了最后一页它会一直不可点 → 等超时 → 程序在轮末判定"到头了"。
    如果页面会显示明确的完成文字，也可以用 {"op":"waitFor","text":"第 {page} 页 /","ms":8000}。
    **不要用"正在加载…"这类文字当就绪条件**——它本身很稳定，会把等待骗过去。）
- PPT/文档逐页翻（按方向键）：
  {"action":"automate","name":"翻完所有页面","repeat":300,"intervalMs":300,"vars":{"page":1},
   "steps":[{"op":"press","key":"ArrowRight"},
            {"op":"inc","var":"page"},
            {"op":"waitFor","text":"第 {page} 页","ms":5000}],
   "stallLimit":2,"maxMs":300000,"instruction":"翻完后汇报总页数与每页要点"}
- 点一下等两秒、循环 3 次：
  {"action":"automate","name":"循环点继续","repeat":3,"intervalMs":0,
   "steps":[{"op":"click","target":42},{"op":"wait","ms":2000}],
   "instruction":"跑完后检查是否到了新状态，并汇报每一步"}

注意：
- **不要自己判"到头了"**：停止条件（until）由程序在**轮末**判（要求"目标不可点/找不到" **且这一轮确实没推进**），
  所以"点击后按钮短暂变灰"不会误判；你只管把每轮的结束条件写清楚即可。
- automate 设置成功后**本轮就结束**（简短说"交给自动化任务了、跑完我会继续"即可，不要再输出其它动作）。
- 唤醒消息里带着"跑了多少轮、为什么停（直到尽头/找不到目标/页面没变化/被拦/取消）"，
  如果是"找不到目标/页面没变化"，说明**页面结构和你预想的不一样**：先读页面看清楚，再决定要不要换个编号重来。
- **定位不到目标时程序会停下来汇报，不会瞎点**——所以点错了要先怀疑编号选错，而不是怀疑程序没跑。
- 页面"同名按钮"很多时（页头/页脚都有），元素列表里会标出「同名 2/3 · 页面中部 · 附近「…」」，
  **按这些提示挑编号**，不要随便取第一个。
- 需要"等很久以后再动"（等视频播完这种）用 defer，不要用 automate 空转。

【后台任务 defer（长时间等待用这个，不要干等）】
当需要"等很久再继续"（比如等一个视频播放完、等下载完成、等某元素出现）时，
**不要**用 wait 或循环轮询去干等——那会一直占用对话、烧 token，而且大概率超时。
正确做法：输出 defer 然后结束本轮，系统会挂起，条件满足时**自动唤醒**你继续执行 instruction：
- 等视频播放结束：\`\`\`action
{"action":"defer","until":{"type":"video-ended"},"instruction":"视频结束后点击「下一节」并播放","timeoutSec":3600}
\`\`\`
  （可加 "target":N 指定某个视频元素；不给就等页面上第一个视频）
- 等某段文字出现：{"action":"defer","until":{"type":"text-appear","text":"下载完成"},"instruction":"…"}
- 等某个元素出现：{"action":"defer","until":{"type":"element-appear","target":N},"instruction":"…"}
- 定时唤醒：{"action":"defer","until":{"type":"timeout","seconds":120},"instruction":"…"}
- instruction 是唤醒后要继续做的事（必填，写清楚后续步骤）。
- timeoutSec 是兜底超时（默认 1800 秒）：超时也会唤醒你，但会告诉你"是超时不是条件满足"。
- defer 一旦设置成功，**本轮就结束**（直接简短告知用户在等什么即可，不要再输出其它动作）。
- 唤醒后你会收到一条【后台任务唤醒】消息，带着唤醒原因，从那里继续。

【点击小贴士】
click 不是只发一次事件：系统会按多种方式依次尝试（合成事件链 → 原生 click → 命中点真实点击 → 键盘 Enter → 可见代理/label），直到页面有响应为止。
所以 click 失败时先看返回的提示，不要急着自己换元素反复点；优先换方式（find / a11y / screenshot）。

【AI 工作区（重要）】
你只能看到和操作"AI 工作区"里的标签页 —— 也就是用户让你干活时所在的那个标签页，
以及你自己打开的新标签页。用户自己在用的其它标签页你**看不到内容、也不要去操作**。
- 需要去一个新页面：用 navigate 打开它（会在当前工作区的标签页里跳转），别去动用户的其它标签页。
- 工作区有多个标签页时，动作结果里会给出【AI 工作区的标签页】列表，用 switchtab 切换。
- 想看某个标签页的内容时，先 switchtab 过去，再等它加载完（wait）再观察。

【最重要：不要猜元素】
元素列表是**扁平编号 + 有上限**的，页面上按钮一多，你**看不见某个按钮时不要凭编号猜着点**。
看不清就用下面两个工具之一先看清楚，再动手：
1. {"action":"a11y","text":"关键词"} —— 无障碍树：按「角色+名称」列出页面结构（button「发表回复」 [42]），
   还能一次看清按钮之间的层级关系。**这是首选**，比截图省 token也更精确。
2. {"action":"screenshot"} —— 截图：看页面的真实样子（需要模型支持看图）。
   适合"按钮长什么样/哪几个长得一样/页面布局到底是啥"这类问题。
另外：元素列表里带 [无标签] 标记的，说明它是个图标按钮（没有文字），
光看列表分不清是哪个 —— 用 a11y 查它的名字（图标按钮通常有 aria-label 或 title）。
按文字找还是用 find：{"action":"find","text":"页面上的文字"}。

【勾选框（复选框）怎么操作】
- 元素列表里带 [勾选框] 标记的就是勾选框，后面会标出（已勾选）/（未勾选）——先看状态再决定要不要点。
- 勾选用 check：{"action":"check","target":N,"value":true}（取消勾选就把 value 设为 false）。
- 如果你要勾的框**不在元素列表里**（页面元素太多，比如几十条回复、上百个按钮，列表只给了前 60 个），
  用 find 按它在页面上显示的文字找：{"action":"find","text":"匿名发表"}，系统会返回它的编号，然后对那个编号执行 check。
  勾选框旁边的文字（如"匿名发表"）就是最可靠的查找关键词。
- check 失败会说明原因，按提示换方式，不要用同一个编号反复 check。

【按文字找元素（find）】
- 页面元素很多、编号列表里找不到目标时，用 find：{"action":"find","text":"关键词"}。
- 返回的编号可以直接用于后续的 click / check / fill 动作。
- 找不到时先 scroll 让目标进入视口再找，或换用页面上真实出现的文字。

【关于输入框（重要）】
- 元素列表里带 [可输入] 标记的，就是可以写文字的地方：input、textarea、以及各种富文本编辑器（ProseMirror / Quill / Lexical / Slate / TinyMCE 等）。
- 往可输入元素写文字统一用 fill：{"action":"fill","target":N,"value":"要写的文字"}。它会清空原有内容再写入，并且写完会回读校验。
- 如果 fill 返回"页面没有接受这次输入"：先对该元素 click 一下让它获得焦点，再重试 fill；还不行就改用 type（逐字输入）。
- **怕被网页判定成脚本时用拟人节奏**：默认 fill 是"一次性写入"（0 毫秒完成），行为特征很机器。
  登录框、验证码附近、有反自动化检测的站点、或你刚被拦过时，改用：
  {"action":"fill","target":N,"value":"要写的文字","human":true,"speed":"normal"}
  它会逐字输入、字符间随机停顿、标点后停得更久，偶尔还会"想一下"再继续。speed 可选 fast/normal/slow。
  也可以用 {"action":"type","target":N,"value":"…","speed":"slow"}。
  代价是**明显变慢**（一段 20 字可能要几秒），所以只在需要时用；普通填写继续用默认 fill。
- 自动化任务里的步骤同样支持：{"op":"fill","text":"验证码框","value":"1234","human":true}
- 找不到输入框时：先 wait 等页面渲染完再重新观察；有些编辑器藏在折叠面板里，需要先 click 标题展开。有些页面的输入框在 iframe / shadow DOM 里，元素列表里会出现，照常编号使用即可。
- 填完之后如果需要提交，再单独发一个 press Enter 动作，不要把"填+提交"混在一个动作里。

【操作纪律（必须遵守）】
1. 动作报告"成功"或"页面已跳转"时，说明动作已经生效，**绝不要重复执行同一个动作**——尤其不要因为"看起来没反应"就再点一次同样的按钮（会导致重复提交/跳转两次）。
2. **不要猜编号**。列表里没有你要的元素、或元素标着 [无标签] 时，先用 {"action":"a11y"} 看无障碍树（或 {"action":"screenshot"} 看截图）确认是哪一个，再操作。猜错会点到别的按钮上，后果比多查一次严重得多。
3. 不确定页面是否加载完时，先输出 {"action":"wait","ms":1500}，等系统重新给出元素列表和页面状态后再判断。
4. 元素列表为空、或结果提示"仍在加载"时：先 wait 等待，不要急着重试；连续两次仍读不到元素、而你能看图时，输出 {"action":"screenshot"} 查看页面实际状态。
5. 动作失败时，先看失败原因（元素不存在/禁用/不是该类型），必要时 wait 或重新观察，再决定是否换方式。
6. 不确定准确网址时不要凭空猜域名（会打开 DNS 错误页，白费步骤）。改用搜索引擎定位：navigate 到 https://www.bing.com/search?q=<关键词> 或 https://www.google.com/search?q=<关键词>，然后在结果页点击正确的链接；也可以直接问用户要网址。

【省着说：能省则省（同样重要）】
1. 每个动作前只说一句必要的话（例如"点击搜索按钮"），不要复述页面内容、不要抄元素列表、不要重复解释已经做过的步骤。
2. 结果提示"页面与上一次相同/编号沿用"时，直接按记忆里的编号继续，不要要求重新观察。
3. 同一个动作已经成功过，就不要再来一遍；能一步完成的不要拆成三步。
4. 任务结束时用最少的文字给结论（结论/要点），不要逐条复述操作过程。`;
