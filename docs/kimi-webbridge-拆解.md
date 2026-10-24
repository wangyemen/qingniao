# Kimi 浏览器扩展（WebBridge）拆解笔记

> 来源：官方包 `https://cdn.kimi.com/webbridge/latest/extension/kimi-webbridge-extension.zip`（v2.0.26，解包 93 文件，WXT 框架打包）
> 用途：借鉴机制设计，不复制其代码。2026-10-22 拆解。

## 架构确认

- MV3，权限含 **`debugger`**（CDP）、tabs/scripting/webRequest/webNavigation/sidePanel/unlimitedStorage
- content-scripts：`record.js`（操作录制）、`selection.js`（划词），`<all_urls>`
- 本地桥接：`kimi-webbridge.exe` 守护进程（`cdn.kimi.com/webbridge/{ver}/releases/`），供 Claude Code 等外部 Agent 远程驱动

## 关键机制（值得借鉴）

1. **输入走 CDP = 可信事件**（防检测的核心）
   - 点击：`Input.dispatchMouseEvent` 序列 `mouseMoved`（悬停）→ `mousePressed`(left, clickCount:1) → `mouseReleased`，在元素中心坐标上发
   - 键盘：`Input.dispatchKeyEvent`；文本：`Input.insertText`
   - 页面 JS 看到的 `isTrusted=true`，与真人输入无法区分
2. **点击投递探针**：点击后 `Runtime.evaluate` 回读验证（`window.__wbClickProbe` / `__wbClickDelivered`），确认动作真的生效，而不是发了就算
3. **元素引用三种定位**："CSS selector、`@e` ref、semantic locator"，ref 由 snapshot 产出并跨步骤维护（"unknown ref, run snapshot first"）——与我们的编号表同思路，但 ref 跨快照持久
4. **绝不抢用户焦点**：显式拒绝 `Target.activateTarget`（源码注释：激活标签页会把 Chrome 抢到前台、用户按键会打到那个标签）——防打扰设计，值得抄
5. fill 支持按 ref 或选择器，`fillByRef` + CDP 文本插入

## 防检测真相

- **没有** webdriver 指纹清洗（无 `navigator.webdriver` 补丁、无 cdc_ 对抗）——不做军备竞赛
- 防检测靠的就是 CDP 可信输入这一个杀手锏
- 反而它自己留了主世界全局（`window.__wb*`、`data-pressed` 等）作探针/视觉层——为可靠性牺牲了一点点隐身
- content scripts 用 `isTrusted` 过滤（录制动作时只认真人事件）

## 对我们（0.3 路线图）的启示

| 我们现在 | Kimi 做法 | 0.3 改进方向 |
|---|---|---|
| 合成事件 isTrusted=false | CDP Input 域 | chrome.debugger 通道做可信输入（接受调试黄条） |
| 动作发出即认为成功 | 点击探针验证 | 增加投递探针 + 失败自动重试 |
| 每次快照重新编号 | ref 跨步骤持久 | 可选：ref 持久化减少 token |
| scrollIntoView + focus | 不激活标签页 | 保持现状（已不抢焦点），可抄"拒绝 activate"原则 |
