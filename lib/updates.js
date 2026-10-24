// 版本与更新检查：解析 version.txt、比对版本、拿更新日志。
//
// version.txt 有两份用途：
//   ① 扩展里随包带一份（本地更新日志，更新后弹窗直接读它，不依赖网络）；
//   ② 仓库根目录也放一份（联网时比对"仓库里有没有更新的版本"）。
//
// 纯逻辑，不碰 chrome.*（URL 由调用方传进来）。

import { compareVersion } from "./skills.js";

export const REMOTE_VERSION_TXT =
  "https://raw.githubusercontent.com/wangyemen/qingniao/main/version.txt";

export const UPDATE_STATE_KEY = "ai_update_state";

// 解析 version.txt：
//   latest: 0.7.0
//   released: 2026-10-25
//   repo: https://...
//   ## 0.7.0
//   - ...
export function parseVersionTxt(text) {
  const src = String(text || "");
  const head = { latest: "", released: "", repo: "", title: "" };
  const entries = [];
  let cur = null;

  for (const raw of src.split(/\r?\n/)) {
    const line = raw.replace(/\s+$/, "");
    const h = /^(latest|released|repo)\s*:\s*(.+)$/i.exec(line.trim());
    if (h) {
      head[h[1].toLowerCase()] = h[2].trim();
      continue;
    }
    const sec = /^##\s+(.+?)\s*$/.exec(line);
    if (sec) {
      cur = { version: sec[1].trim(), lines: [] };
      entries.push(cur);
      continue;
    }
    if (!cur) {
      if (line.trim() && !head.title) head.title = line.trim();
      continue;
    }
    if (line.trim()) cur.lines.push(line.trim());
  }

  // latest 缺省时用第一条版本段落
  if (!head.latest && entries.length) head.latest = entries[0].version;
  return { ...head, entries };
}

// 取 "大于 fromVersion 且不超过 toVersion" 的更新日志段落（新→旧）
export function changelogBetween(vt, fromVersion, toVersion) {
  const out = [];
  for (const e of vt.entries || []) {
    if (toVersion && compareVersion(e.version, toVersion) > 0) continue;
    if (fromVersion && compareVersion(e.version, fromVersion) <= 0) continue;
    out.push(e);
  }
  return out;
}

// 当前仓库里是否有比 installed 更新的版本
export function newerThan(vt, installed) {
  if (!vt || !vt.latest) return null;
  return compareVersion(vt.latest, installed) > 0 ? vt.latest : null;
}

// 读本地随包的 version.txt（扩展页面里用）
export async function loadLocalVersionTxt() {
  try {
    const res = await fetch(chrome.runtime.getURL("version.txt"), { cache: "no-cache" });
    if (!res.ok) throw new Error("HTTP " + res.status);
    return parseVersionTxt(await res.text());
  } catch (_) {
    return null;
  }
}

// 联网读仓库里的 version.txt（失败就静默返回 null，绝不打扰用户）
export async function loadRemoteVersionTxt({ timeoutMs = 8000 } = {}) {
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), timeoutMs);
    const res = await fetch(REMOTE_VERSION_TXT + "?t=" + Date.now(), {
      cache: "no-cache",
      signal: ctl.signal,
    });
    clearTimeout(t);
    if (!res.ok) throw new Error("HTTP " + res.status);
    return parseVersionTxt(await res.text());
  } catch (_) {
    return null;
  }
}