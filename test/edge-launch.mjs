// 测试用 Edge 启动器：手动 spawn + CDP 连接（共享给 e2e / probe-panel）
// 背景：Edge 155 的 launcher 进程会把真浏览器 fork 出去后自己秒退（exit 0），
// puppeteer.launch 会把"子进程退出"误判成启动失败。所以手动拉起 + connect。
// 端口用 --remote-debugging-port=0 让浏览器自选空闲端口（写入 DevToolsActivePort），
// 避免随机端口撞上残留进程后连到别的浏览器实例（曾导致 Target.getBrowserContexts 报错）。
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire("C:/Users/yemen/.workbuddy/binaries/node/workspace/package.json");
const puppeteer = require("puppeteer-core");

export const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 按 user-data-dir 找到真浏览器进程并杀掉（Edge launcher 秒退后 proc.kill 杀不到真浏览器） */
export async function killByProfile(profile) {
  try {
    const { execFile } = await import("node:child_process");
    const esc = String(profile).replace(/'/g, "''");
    await new Promise((resolve) => {
      execFile(
        "powershell",
        [
          "-NoProfile",
          "-Command",
          `Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" | Where-Object { $_.CommandLine -like '*${esc}*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`,
        ],
        { windowsHide: true, timeout: 8000 },
        () => resolve()
      );
    });
  } catch (_) {}
}

/**
 * 启动独立 profile 的无头 Edge 并用 puppeteer.connect 连上。
 * @param {object} opts
 * @param {string} opts.profile  user-data-dir（调用方创建）
 * @param {string[]} [opts.loadExtensions]  要 --load-extension 的目录列表（须纯 ASCII）
 * @param {string[]} [opts.extraArgs]
 * @param {number} [opts.timeoutMs]
 * @returns {Promise<import('puppeteer-core').Browser & {__launcherProc: import('node:child_process').ChildProcess}>}
 */
export async function launchEdge(opts) {
  const { profile, loadExtensions = [], extraArgs = [], timeoutMs = 30000 } = opts;
  const args = [
    `--user-data-dir=${profile}`,
    ...(loadExtensions.length
      ? [`--disable-extensions-except=${loadExtensions[0]}`, ...loadExtensions.map((d) => `--load-extension=${d}`)]
      : []),
    "--no-first-run",
    "--no-default-browser-check",
    "--window-size=1280,800",
    "--headless=new",
    "--remote-debugging-port=0",
    ...extraArgs,
    "about:blank",
  ];
  const proc = spawn(EDGE, args, { stdio: "ignore", windowsHide: true });

  // 等 DevToolsActivePort：第一行端口，第二行 browser 级 ws 路径（/devtools/browser/<uuid>）。
  // 注意：launcher 进程 fork 出真浏览器后会立刻退出（exit 0），这是正常现象，
  // 不能把 proc.exitCode 当成启动失败 —— 要等文件出现。
  const portFile = path.join(profile, "DevToolsActivePort");
  const deadline = Date.now() + timeoutMs;
  let port = null;
  let wsPath = null;
  while (Date.now() < deadline) {
    try {
      const lines = fs.readFileSync(portFile, "utf8").split(/\r?\n/);
      port = parseInt(lines[0], 10);
      wsPath = lines[1] || null;
      if (port && wsPath) break;
    } catch (_) {}
    await sleep(200);
  }
  if (!port || !wsPath) {
    try { proc.kill(); } catch (_) {}
    await killByProfile(profile);
    throw new Error("Edge CDP 端点未就绪（DevToolsActivePort 超时）");
  }

  // 用 /json/version 取 browser 级 webSocketDebuggerUrl，并校验端点类型
  let wsUrl = null;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`);
      const info = await res.json();
      const u = info && info.webSocketDebuggerUrl;
      // 必须是 browser 级端点；page 级端点上 Target.getBrowserContexts 会报 Method not found
      if (u && u.includes("/devtools/browser/")) {
        wsUrl = u;
        break;
      }
    } catch (_) {}
    await sleep(200);
  }
  if (!wsUrl) {
    try { proc.kill(); } catch (_) {}
    await killByProfile(profile);
    throw new Error("Edge CDP 端点不是 browser 级（/json/version 校验失败）");
  }

  let b;
  try {
    b = await puppeteer.connect({ browserWSEndpoint: wsUrl, protocolTimeout: 60000 });
  } catch (err) {
    try { proc.kill(); } catch (_) {}
    await killByProfile(profile);
    throw err;
  }
  b.__launcherProc = proc;
  // 关掉浏览器：connect 模式下 close() 发 Browser.close 关掉真浏览器；
  // 再按 profile 补杀残留（launcher 已退出，proc.kill 杀不到真浏览器进程）。
  const origClose = b.close.bind(b);
  b.close = async () => {
    await origClose().catch(() => {});
    try { proc.kill(); } catch (_) {}
    await killByProfile(profile);
  };
  return b;
}

/** 只认自己扩展的 SW target（排除 Edge 组件扩展的 background.rollup.js 之类） */
export function isOwnServiceWorker(target) {
  return target.type() === "service_worker" && /\/background\/service-worker\.js$/.test(target.url());
}
