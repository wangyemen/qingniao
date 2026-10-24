// 附件处理：图片压缩、PDF 文本提取、纯文本读取
// 图片走 vision content block（仅当条消息携带，不进历史）；文档抽成文本进消息。

const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
const TEXT_EXTS = new Set([
  "txt", "md", "csv", "json", "log", "js", "ts", "jsx", "tsx",
  "py", "html", "css", "xml", "yaml", "yml", "sql", "sh", "bat",
]);

const MAX_IMAGE_SIDE = 1280;
const MAX_DOC_CHARS = 12000;

export function isImageFile(file) {
  return IMAGE_TYPES.has(file.type);
}

export function extOf(name) {
  const m = /\.([a-z0-9]+)$/i.exec(name || "");
  return m ? m[1].toLowerCase() : "";
}

export function isTextFile(file) {
  return TEXT_EXTS.has(extOf(file.name));
}

export function isPdfFile(file) {
  return file.type === "application/pdf" || extOf(file.name) === "pdf";
}

// 统一入口：返回 { kind: "image"|"text", name, dataUrl?|text, truncated }
export async function processFile(file) {
  if (isImageFile(file)) {
    const raw = await readAsDataURL(file);
    const dataUrl = await downscaleImage(raw, MAX_IMAGE_SIDE);
    return { kind: "image", name: file.name, dataUrl };
  }
  if (isPdfFile(file)) {
    const text = await extractPdfText(file);
    return finalizeText(file.name, text);
  }
  if (isTextFile(file)) {
    const text = await readAsText(file);
    return finalizeText(file.name, text);
  }
  throw new Error("不支持的文件类型：" + (file.name || file.type || "未知"));
}

function finalizeText(name, text) {
  let truncated = false;
  if (text.length > MAX_DOC_CHARS) {
    text = text.slice(0, MAX_DOC_CHARS);
    truncated = true;
  }
  return { kind: "text", name, text, truncated };
}

function readAsDataURL(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(new Error("读取文件失败"));
    r.readAsDataURL(file);
  });
}

function readAsText(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result || ""));
    r.onerror = () => reject(new Error("读取文件失败"));
    r.readAsText(file);
  });
}

// 图片压到最长边 maxSide 的 JPEG，控制 token 成本
export function downscaleImage(dataUrl, maxSide) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const { width, height } = img;
      const scale = Math.min(1, maxSide / Math.max(width, height));
      const w = Math.round(width * scale);
      const h = Math.round(height * scale);
      const canvas = document.createElement("canvas");
      canvas.width = w;
      canvas.height = h;
      canvas.getContext("2d").drawImage(img, 0, 0, w, h);
      resolve(canvas.toDataURL("image/jpeg", 0.72));
    };
    img.onerror = () => reject(new Error("图片处理失败"));
    img.src = dataUrl;
  });
}

// PDF 文本提取（pdf.js 本地打包在 lib/pdf/）
export async function extractPdfText(file) {
  const buf = await file.arrayBuffer();
  const pdfjs = await import("./pdf/pdf.min.mjs");
  pdfjs.GlobalWorkerOptions.workerSrc = new URL("./pdf/pdf.worker.min.mjs", import.meta.url).href;
  const doc = await pdfjs.getDocument({ data: buf }).promise;
  const parts = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    parts.push(content.items.map((it) => it.str).join(" "));
    if (parts.join("\n").length > MAX_DOC_CHARS) break;
  }
  return parts.join("\n");
}

// 粘贴事件里的图片 File
export function imagesFromClipboard(e) {
  const files = [];
  if (!e.clipboardData) return files;
  for (const item of e.clipboardData.items || []) {
    if (item.kind === "file") {
      const f = item.getAsFile();
      if (f && isImageFile(f)) files.push(f);
    }
  }
  return files;
}
