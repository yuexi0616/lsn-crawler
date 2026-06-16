/**
 * content.js — 注入到 LMS 作业页面
 * 功能：提取页面内容 → 转 Markdown → 触发下载
 */

// ============================================================
// 页面注入按钮
// ============================================================
function injectButton() {
  if (document.getElementById("__lsn_save_btn")) return;

  const btn = document.createElement("button");
  btn.id = "__lsn_save_btn";
  btn.textContent = "保存为 Markdown";
  Object.assign(btn.style, {
    position: "fixed",
    bottom: "20px",
    right: "20px",
    zIndex: "99999",
    padding: "10px 20px",
    backgroundColor: "#2563eb",
    color: "#fff",
    border: "none",
    borderRadius: "8px",
    fontSize: "14px",
    fontWeight: "bold",
    cursor: "pointer",
    boxShadow: "0 4px 12px rgba(0,0,0,0.2)",
    transition: "background 0.2s",
  });
  btn.addEventListener("mouseenter", () => (btn.style.backgroundColor = "#1d4ed8"));
  btn.addEventListener("mouseleave", () => (btn.style.backgroundColor = "#2563eb"));
  btn.addEventListener("click", async () => {
    btn.textContent = "正在保存...";
    btn.disabled = true;
    try {
      const { filename, content, images } = await extractAndConvert();
      // 通过 background 打包下载 zip
      const title = filename.replace(/\.md$/, "");
      await chrome.runtime.sendMessage({ action: "downloadZip", title, md: content, images });
      btn.textContent = "已保存: " + title + ".zip!";
      setTimeout(() => {
        btn.textContent = "保存为 Markdown";
        btn.disabled = false;
      }, 2000);
    } catch (e) {
      btn.textContent = "失败: " + e.message;
      btn.style.backgroundColor = "#dc2626";
      setTimeout(() => {
        btn.textContent = "保存为 Markdown";
        btn.disabled = false;
        btn.style.backgroundColor = "#2563eb";
      }, 3000);
    }
  });
  document.body.appendChild(btn);
}

// ============================================================
// 下载文件
// ============================================================
function downloadFile(filename, content) {
  const blob = new Blob([content], { type: "text/markdown;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// ============================================================
// 标题提取
// ============================================================
function extractTitle() {
  let title = document.title.trim();
  title = title.replace(/\s*[：:]\s*LMS\s*$/, "");
  // 安全文件名
  title = title.replace(/[\\/:*?"<>|]/g, "-");
  return title || "实验手册";
}

// ============================================================
// 核心：HTML → Markdown
// ============================================================
async function extractAndConvert() {
  const userContent = document.querySelector(".description.user_content");
  if (!userContent) {
    throw new Error("未找到 user_content 区域");
  }

  const title = extractTitle();
  const safeName = title.replace(/[\\/:*?"<>|]/g, "-");

  // 克隆节点，获取图片并生成独立文件名
  const clone = userContent.cloneNode(true);
  const imgs = clone.querySelectorAll("img");
  const imageFiles = [];
  let imgIndex = 0;

  await Promise.all(Array.from(imgs).map(async (img) => {
    let src = img.getAttribute("src");
    if (!src) return;
    if (src.startsWith("/")) src = "http://10.30.0.135" + src;
    try {
      const resp = await fetch(src);
      if (!resp.ok) { img.setAttribute("src", src); return; }
      const blob = await resp.blob();
      const dataUrl = await new Promise((resolve) => {
        const reader = new FileReader();
        reader.onloadend = () => resolve(reader.result);
        reader.readAsDataURL(blob);
      });
      const mime = blob.type || "";
      const ext = mime.includes("png") ? "png" : mime.includes("gif") ? "gif" : mime.includes("svg") ? "svg" : mime.includes("webp") ? "webp" : "jpg";
      imgIndex++;
      const imgFilename = safeName + "_img" + String(imgIndex).padStart(2, "0") + "." + ext;
      img.setAttribute("src", imgFilename);
      imageFiles.push({ filename: imgFilename, dataUrl });
    } catch (e) {
      img.setAttribute("src", src);
    }
  }));

  const md = nodeToMarkdown(clone);
  return { filename: title + ".md", content: md + "\n", images: imageFiles };
}

function nodeToMarkdown(root) {
  const lines = [];
  walk(root, lines);
  // 清洗
  let text = lines.join("");
  text = text.replace(/\u00a0/g, "").replace(/\u200b/g, "");
  text = text
    .split("\n")
    .map((s) => s.trimEnd())
    .join("\n");
  text = text.replace(/\n{3,}/g, "\n\n");
  text = text.trim();
  return fixCodeBlocks(text);
}

function walk(node, lines) {
  for (let child = node.firstChild; child; child = child.nextSibling) {
    if (child.nodeType === Node.TEXT_NODE) {
      lines.push(child.textContent);
      continue;
    }

    if (child.nodeType !== Node.ELEMENT_NODE) continue;

    const tag = child.tagName.toLowerCase();

    switch (tag) {
      // --- 代码块 ---
      case "pre":
        lines.push("\n```\n");
        lines.push(child.textContent);
        lines.push("\n```\n");
        break;

      case "code":
        // 跳过 pre 内的 code（已被 pre 处理）
        if (child.parentElement?.tagName.toLowerCase() === "pre") {
          walk(child, lines);
        } else {
          lines.push("`" + child.textContent + "`");
        }
        break;

      // --- 标题 ---
      case "h1":
      case "h2":
      case "h3":
      case "h4":
      case "h5":
      case "h6": {
        const level = parseInt(tag[1]);
        lines.push("\n" + "#".repeat(level) + " " + child.textContent.trim() + "\n");
        break;
      }

      // --- 段落 ---
      case "p":
        lines.push("\n");
        walk(child, lines);
        lines.push("\n");
        break;

      case "br":
        lines.push("\n");
        break;

      // --- 列表 ---
      case "li":
        lines.push("\n- ");
        walk(child, lines);
        break;

      case "ul":
      case "ol":
        lines.push("\n");
        walk(child, lines);
        lines.push("\n");
        break;

      // --- 行内格式 ---
      case "strong":
      case "b":
        lines.push("**");
        walk(child, lines);
        lines.push("**");
        break;

      case "em":
      case "i":
        lines.push("*");
        walk(child, lines);
        lines.push("*");
        break;

      // --- 容器（透传内容） ---
      case "span":
      case "div":
      case "a":
        walk(child, lines);
        break;

      // --- 表格 ---
      case "table":
        convertTable(child, lines);
        break;

      // --- 图片 ---
      case "img": {
        let src = child.getAttribute("src") || "";
        const alt = child.getAttribute("alt") || "";
        if (src.startsWith("/")) src = "http://10.30.0.135" + src;
        lines.push(`![${alt}](${src})`);
        break;
      }

      // --- 默认：递归处理 ---
      default:
        walk(child, lines);
        break;
    }
  }
}

// ============================================================
// 简单表格转换
// ============================================================
function convertTable(table, lines) {
  const rows = table.querySelectorAll("tr");
  if (rows.length === 0) return;

  const allRows = [];
  rows.forEach((row) => {
    const cells = row.querySelectorAll("th, td");
    allRows.push(Array.from(cells).map((c) => c.textContent.trim()));
  });

  if (allRows.length === 0) return;

  lines.push("\n");
  // 表头
  lines.push("| " + allRows[0].join(" | ") + " |\n");
  // 分隔线
  lines.push("| " + allRows[0].map(() => "---").join(" | ") + " |\n");
  // 数据行
  for (let i = 1; i < allRows.length; i++) {
    lines.push("| " + allRows[i].join(" | ") + " |\n");
  }
  lines.push("\n");
}

// ============================================================
// 代码块修复 & 语言检测
// ============================================================
// 语言检测：多模式 + 评分机制
const LANG_PATTERNS = [
  { lang: "java",   re: /\b(public\s+(class|interface|enum)|import\s+java\.|package\s+\w+|System\.out|ArrayList|HashMap|IOException)\b/, weight: 3 },
  { lang: "java",   kw: ["@Override", "@Autowired", "@Service", "@Component", "HBaseConfiguration", "NamespaceDescriptor", "ConnectionFactory", "HTableDescriptor"], weight: 2 },
  { lang: "xml",    re: /<\/?[\w:-]+(\s+[^>]*)?\/?>/i,                                                                                weight: 2 },
  { lang: "xml",    kw: ["<?xml", "<dependency>", "<project", "</dependency>", "<beans", "<groupId>", "<artifactId>"],                 weight: 4 },
  { lang: "bash",   re: /^(#!\/bin\/(ba)?sh|\$\s+\w+|sudo\s|apt(-get)?\s|yum\s|systemctl\s)/m,                                       weight: 4 },
  { lang: "bash",   kw: ["#!/bin/bash", "#!/bin/sh", "echo ", "cd /", "hdfs ", "./start", "namenode", "/hbase/", "chmod "],           weight: 2 },
  { lang: "sql",    re: /\b(SELECT\s|INSERT\s+INTO\s|UPDATE\s+\w+\s+SET|DELETE\s+FROM\s|CREATE\s+TABLE|ALTER\s+TABLE|DROP\s+TABLE)\b/i, weight: 5 },
  { lang: "python", re: /\b(def\s+\w+\s*\(|import\s+\w+|from\s+\w+\s+import|print\(|if\s+__name__|class\s+\w+.*:)\b/,                 weight: 3 },
  { lang: "python", kw: ["#!/usr/bin/python", "#!/usr/bin/env python", "self.", "__init__"],                                           weight: 1 },
  { lang: "js",     re: /\b(const\s+\w+\s*=|let\s+\w+\s*=|function\s+\w+\s*\(|=>\s*\{|console\.log)\b/,                               weight: 2 },
  { lang: "js",     kw: ["require(", "module.exports", "export default", "import {", "from '", 'from "'],                               weight: 2 },
  { lang: "json",   re: /^\s*"[^"]+"\s*:\s*/m,                                                                                         weight: 4 },
  { lang: "yaml",   re: /^[\w-]+:\s+/m,                                                                                                weight: 2 },
  { lang: "html",   re: /<!(?:DOCTYPE|--)|<html|<head|<body|<div\b|<meta\s|<link\s/i,                                                 weight: 4 },
  { lang: "c",      re: /\b(#include\s*[<"]|int\s+main\s*\(|printf\(|scanf\(|malloc\(|free\()\b/,                                      weight: 4 },
  { lang: "go",     re: /\b(package\s+main|func\s+\w+\s*\(|import\s+\(|fmt\.\w+\(|go\s+func)\b/,                                      weight: 4 },
  { lang: "rust",   re: /\b(fn\s+main|let\s+mut\s|use\s+std::|impl\s+\w+|struct\s+\w+|println!)\b/,                                   weight: 4 },
  { lang: "docker", kw: ["FROM ", "RUN ", "COPY ", "ADD ", "CMD ", "ENTRYPOINT", "WORKDIR", "EXPOSE"],                                 weight: 5 },
  { lang: "props",  re: /^[^#\s=]+=[^=]+$/m,                                                                                          weight: 2 },
  { lang: "ini",    re: /^\[[\w.-]+\]\s*$/m,                                                                                           weight: 3 },
];

function detectLang(code) {
  const scores = {};
  for (const p of LANG_PATTERNS) {
    let score = 0;
    if (p.re && p.re.test(code)) score += p.weight;
    if (p.kw && p.kw.some(k => code.includes(k))) score += p.weight;
    if (score > 0) scores[p.lang] = (scores[p.lang] || 0) + score;
  }
  let best = "", bestScore = 1;
  for (const [lang, score] of Object.entries(scores)) {
    if (score > bestScore) { best = lang; bestScore = score; }
  }
  return best;
}

function fixCodeBlocks(text) {
  const lines = text.split("\n");
  const result = [];
  let i = 0;
  const n = lines.length;

  while (i < n) {
    const line = lines[i];

    if (line.trim() !== "```" || i + 1 >= n) {
      result.push(line);
      i++;
      continue;
    }

    let end = i + 1;
    while (end < n && lines[end].trim() !== "```") end++;

    if (end >= n) {
      result.push(line);
      i++;
      continue;
    }

    const codeLines = lines.slice(i + 1, end);
    const hasWrapping = codeLines.some((cl) => cl.trim().startsWith("`"));

    let cleaned;
    if (hasWrapping) {
      cleaned = codeLines.map((cl) => {
        let s = cl;
        const stripped = s.trim();
        if (stripped.startsWith("`")) {
          const idx = s.indexOf("`");
          s = s.slice(0, idx) + s.slice(idx + 1);
        }
        if (s.trim().endsWith("`") && s.trim().length > 1) {
          const idx = s.lastIndexOf("`");
          s = s.slice(0, idx) + s.slice(idx + 1);
        }
        return s;
      });
    } else {
      cleaned = codeLines;
    }

    const lang = detectLang(cleaned.join("\n"));
    result.push("```" + lang);
    result.push(...cleaned);
    result.push("```");

    i = end + 1;
  }

  return result.join("\n");
}

// ============================================================
// 监听来自 popup 的消息
// ============================================================
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.action === "savePage" || msg.action === "savePageFromBatch") {
    (async () => {
      try {
        const { filename, content, images } = await extractAndConvert();
        const title = filename.replace(/\.md$/, "");
        await chrome.runtime.sendMessage({ action: "downloadZip", title, md: content, images });
        sendResponse({ success: true, filename });
      } catch (e) {
        sendResponse({ success: false, error: e.message });
      }
    })();
    return true;
  }
  if (msg.action === "getPageInfo") {
    sendResponse({
      title: extractTitle(),
      hasContent: !!document.querySelector(".description.user_content"),
    });
    return true;
  }
});

// ============================================================
// 初始化
// ============================================================
injectButton();