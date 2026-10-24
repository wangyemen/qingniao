(() => {
  if (globalThis.__aiBrowseExtractInstalled) return;
  globalThis.__aiBrowseExtractInstalled = true;

  function normalizeText(t) {
    return String(t || "")
      .replace(/[ \t\u00a0]+/g, " ")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }

  function extract(maxChars) {
    const cap = typeof maxChars === "number" && maxChars > 0 ? maxChars : 6000;

    const title = document.title || "";
    const url = location.href;
    const selection = normalizeText(String(window.getSelection ? window.getSelection() : ""));

    const root =
      document.querySelector("article") ||
      document.querySelector("main") ||
      document.querySelector('[role="main"]') ||
      document.body;

    let text = "";
    if (root) {
      text = normalizeText(root.innerText || root.textContent || "");
    }
    let truncated = false;
    if (text.length > cap) {
      text = text.slice(0, cap);
      truncated = true;
    }

    const headings = [];
    for (const h of document.querySelectorAll("h1,h2,h3")) {
      const t = normalizeText(h.innerText || h.textContent || "");
      if (!t) continue;
      headings.push({ level: h.tagName.toLowerCase(), text: t.slice(0, 120) });
      if (headings.length >= 25) break;
    }

    const links = [];
    const seen = new Set();
    for (const a of document.querySelectorAll("a[href]")) {
      const t = normalizeText(a.innerText || a.textContent || "");
      if (!t) continue;
      const href = a.href;
      if (!href || seen.has(href)) continue;
      seen.add(href);
      links.push({ text: t.slice(0, 80), url: href });
      if (links.length >= 30) break;
    }

    return {
      title,
      url,
      selection,
      text,
      truncated,
      headings,
      links,
      extractedAt: Date.now(),
    };
  }

  // 暴露为全局函数，供 sidepanel 通过 executeScript 直接调用并拿返回值
  globalThis.__aiBrowseExtract = extract;
})();
