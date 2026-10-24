// 「不在工作区」占位页的脚本
//
// 为什么单独做一个页：
//   0.3.0 用 chrome.sidePanel.setOptions({tabId, enabled:false}) 来"隐藏"面板，
//   结果把扩展图标变成死按钮 —— 侧边栏再也点不开（用户反馈的实际故障）。
//   现在改成：面板**始终可开**，工作区外的标签页切换到这张占位页。
//   效果一样（用户看到的是"这个标签页 AI 不管"），但绝不会锁死。

const btn = document.getElementById("adoptBtn");
const tip = document.getElementById("tip");

function setTip(text) {
  if (tip) tip.textContent = text || "";
}

btn.addEventListener("click", async () => {
  btn.disabled = true;
  setTip("正在接管…");
  try {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (!tab || tab.id == null) {
      setTip("找不到当前标签页");
      btn.disabled = false;
      return;
    }
    const win = tab.windowId;
    // 通知 service worker：把这个标签页设为工作区的新根
    const res = await chrome.runtime.sendMessage({
      type: "scope:begin",
      windowId: win,
      tabId: tab.id,
    });
    if (res && res.ok === false) {
      setTip("接管失败，请重试");
      btn.disabled = false;
      return;
    }
    // 切回真正的对话面板
    await chrome.sidePanel.setOptions({ tabId: tab.id, path: "sidepanel/index.html" });
    setTip("已接管，正在打开…");
    // 面板已经在这一页，刷新即可换成正常界面
    setTimeout(() => location.reload(), 120);
  } catch (err) {
    setTip("接管失败：" + String((err && err.message) || err));
    btn.disabled = false;
  }
});
