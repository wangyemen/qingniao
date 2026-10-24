// 探针：哪种启动参数能让 --load-extension 在本机生效
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
const require = createRequire("C:/Users/yemen/.workbuddy/binaries/node/workspace/package.json");
const puppeteer = require("puppeteer-core");

const PROJECT = "E:\\降噪\\浏览器控制";
const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";

const tmpExt = path.join(os.tmpdir(), "wb-probe-ext");
if (!fs.existsSync(tmpExt)) {
  fs.cpSync(PROJECT, tmpExt, {
    recursive: true,
    filter: (s) => !/(\.workbuddy|test|docs|node_modules)(\\|\/|$)/.test(s),
  });
}

const combos = [
  { name: "chrome headless + escape-hatch", exe: CHROME, headless: true, args: ["--disable-features=DisableLoadExtensionCommandLineSwitch"] },
  { name: "chrome headless plain", exe: CHROME, headless: true, args: [] },
  { name: "chrome headless + unsafe-swiftshader", exe: CHROME, headless: true, args: ["--disable-features=DisableLoadExtensionCommandLineSwitch", "--enable-features=AllowLoadExtensionInHeadless"] },
  { name: "edge headless plain", exe: EDGE, headless: true, args: [] },
  { name: "chrome headed offscreen", exe: CHROME, headless: false, args: ["--window-position=-32000,-32000", "--window-size=200,200"] },
];

for (const c of combos) {
  let browser;
  try {
    browser = await puppeteer.launch({
      executablePath: c.exe,
      headless: c.headless,
      userDataDir: fs.mkdtempSync(path.join(os.tmpdir(), "wb-probe-")),
      ignoreDefaultArgs: ["--disable-extensions"],
      args: [
        `--disable-extensions-except=${tmpExt}`,
        `--load-extension=${tmpExt}`,
        "--no-first-run",
        "--no-default-browser-check",
        ...c.args,
      ],
      timeout: 30000,
    });
    let sw = null;
    try {
      sw = await browser.waitForTarget(
        (t) => t.type() === "service_worker" && t.url().startsWith("chrome-extension://"),
        { timeout: 6000 }
      );
    } catch (_) {}
    const targets = browser.targets().map((t) => t.type()).join(",");
    console.log(`${sw ? "YES" : "no "} | ${c.name} | targets: ${targets}`);
  } catch (err) {
    console.log(`ERR | ${c.name} | ${String(err.message).slice(0, 120)}`);
  } finally {
    await browser?.close().catch(() => {});
  }
}
