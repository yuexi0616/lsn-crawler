/**
 * background.js — Service Worker
 * 负责批量爬取调度：依次打开 URL → executeScript 提取 → 打包 zip → 下载
 */

importScripts("jszip.min.js");

const BASE = "http://10.30.0.135";

// 批量任务状态
let batchRunning = false;
let batchQueue = [];
let batchIndex = 0;
let successCount = 0;
let failCount = 0;

// 注入到目标页面的提取函数
async function extractPage() {
  function extractTitle() {
    let title = document.title.trim();
    title = title.replace(/\s*[：:]\s*LMS\s*$/, "");
    title = title.replace(/[\\/:*?"<>|]/g, "-");
    return title || "实验手册";
  }

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
    const lines = text.split("\n"), result = [];
    let i = 0, n = lines.length;
    while (i < n) {
      const line = lines[i];
      if (line.trim() !== "```" || i + 1 >= n) { result.push(line); i++; continue; }
      let end = i + 1;
      while (end < n && lines[end].trim() !== "```") end++;
      if (end >= n) { result.push(line); i++; continue; }
      const codeLines = lines.slice(i + 1, end);
      const hasWrapping = codeLines.some(cl => cl.trim().startsWith("`"));
      let cleaned;
      if (hasWrapping) {
        cleaned = codeLines.map(cl => {
          let s = cl;
          const st = s.trim();
          if (st.startsWith("`")) { const idx = s.indexOf("`"); s = s.slice(0, idx) + s.slice(idx + 1); }
          if (s.trim().endsWith("`") && s.trim().length > 1) { const idx = s.lastIndexOf("`"); s = s.slice(0, idx) + s.slice(idx + 1); }
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

  function convertTable(table, lines) {
    const rows = table.querySelectorAll("tr");
    if (rows.length === 0) return;
    const allRows = [];
    rows.forEach(row => {
      const cells = row.querySelectorAll("th, td");
      allRows.push(Array.from(cells).map(c => c.textContent.trim()));
    });
    if (allRows.length === 0) return;
    lines.push("\n| " + allRows[0].join(" | ") + " |\n");
    lines.push("| " + allRows[0].map(() => "---").join(" | ") + " |\n");
    for (let i = 1; i < allRows.length; i++) {
      lines.push("| " + allRows[i].join(" | ") + " |\n");
    }
    lines.push("\n");
  }

  function walk(node, lines) {
    for (let child = node.firstChild; child; child = child.nextSibling) {
      if (child.nodeType === Node.TEXT_NODE) { lines.push(child.textContent); continue; }
      if (child.nodeType !== Node.ELEMENT_NODE) continue;
      const tag = child.tagName.toLowerCase();
      switch (tag) {
        case "pre": lines.push("\n```\n"); lines.push(child.textContent); lines.push("\n```\n"); break;
        case "code":
          if (child.parentElement && child.parentElement.tagName.toLowerCase() === "pre") { walk(child, lines); }
          else { lines.push("`" + child.textContent + "`"); }
          break;
        case "h1": case "h2": case "h3": case "h4": case "h5": case "h6": {
          const lv = parseInt(tag[1]);
          lines.push("\n" + "#".repeat(lv) + " " + child.textContent.trim() + "\n");
          break;
        }
        case "p": lines.push("\n"); walk(child, lines); lines.push("\n"); break;
        case "br": lines.push("\n"); break;
        case "li": lines.push("\n- "); walk(child, lines); break;
        case "ul": case "ol": lines.push("\n"); walk(child, lines); lines.push("\n"); break;
        case "strong": case "b": lines.push("**"); walk(child, lines); lines.push("**"); break;
        case "em": case "i": lines.push("*"); walk(child, lines); lines.push("*"); break;
        case "span": case "div": case "a": walk(child, lines); break;
        case "table": convertTable(child, lines); break;
        case "img": {
          let src = child.getAttribute("src") || "";
          const alt = child.getAttribute("alt") || "";
          if (src.startsWith("/")) src = "http://10.30.0.135" + src;
          lines.push("![" + alt + "](" + src + ")");
          break;
        }
        default: walk(child, lines); break;
      }
    }
  }

  function nodeToMarkdown(root) {
    const lines = [];
    walk(root, lines);
    let text = lines.join("");
    text = text.replace(/\u00a0/g, "").replace(/\u200b/g, "");
    text = text.split("\n").map(s => s.trimEnd()).join("\n");
    text = text.replace(/\n{3,}/g, "\n\n");
    text = text.trim();
    return fixCodeBlocks(text);
  }

  const userContent = document.querySelector(".description.user_content");
  if (!userContent) return { ok: false, error: "未找到 .description.user_content" };

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
  return { ok: true, title, md, images: imageFiles };
}

// ============================================================
// 消息处理
// ============================================================
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  switch (msg.action) {
    case "startBatch": {
      const { startAssign, endAssign, startModule, endModule } = msg;
      const count = endAssign - startAssign + 1;
      const moduleCount = endModule - startModule + 1;
      if (count !== moduleCount || count <= 0) {
        sendResponse({ success: false, error: "范围数量不匹配或无效" });
        return true;
      }

      batchQueue = [];
      for (let i = 0; i < count; i++) {
        batchQueue.push(
          `${BASE}/courses/194/assignments/${startAssign + i}?module_item_id=${startModule + i}`
        );
      }
      batchIndex = 0;
      successCount = 0;
      failCount = 0;
      batchRunning = true;

      sendResponse({ success: true, total: batchQueue.length });
      processNext();
      return true;
    }

    case "getBatchStatus": {
      sendResponse({
        running: batchRunning,
        current: batchIndex,
        total: batchQueue.length,
        success: successCount,
        fail: failCount,
      });
      return true;
    }

    case "stopBatch": {
      batchRunning = false;
      batchQueue = [];
      sendResponse({ success: true });
      return true;
    }

    case "downloadZip": {
      (async () => {
        const { title, md, images } = msg;
        const zip = new JSZip();
        const folder = zip.folder(title);
        const imgFolder = folder.folder(title + "_files");

        folder.file(title + ".md", md);
        for (const img of (images || [])) {
          const base64 = img.dataUrl.split(",")[1];
          imgFolder.file(img.filename, base64, { base64: true });
        }

        const zipBlob = await zip.generateAsync({ type: "blob" });
        const zipUrl = URL.createObjectURL(zipBlob);

        await chrome.downloads.download({ url: zipUrl, filename: title + ".zip", saveAs: false });
        setTimeout(() => URL.revokeObjectURL(zipUrl), 5000);
        sendResponse({ success: true });
      })();
      return true;
    }
  }
});

// ============================================================
// 批量处理
// ============================================================
async function processNext() {
  if (!batchRunning || batchIndex >= batchQueue.length) {
    batchRunning = false;
    return;
  }

  const url = batchQueue[batchIndex];
  batchIndex++;

  try {
    const tab = await chrome.tabs.create({ url, active: false });
    await waitForTabLoad(tab.id);

    // 用 executeScript 注入提取函数
    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: extractPage,
    });

    const data = results?.[0]?.result;
    if (data?.ok) {
      // 打包为 zip
      const zip = new JSZip();
      const folder = zip.folder(data.title);
      const imgFolder = folder.folder(data.title + "_files");

      folder.file(data.title + ".md", data.md + "\n");
      for (const img of (data.images || [])) {
        const base64 = img.dataUrl.split(",")[1];
        imgFolder.file(img.filename, base64, { base64: true });
      }

      const zipBlob = await zip.generateAsync({ type: "blob" });
      const zipUrl = URL.createObjectURL(zipBlob);

      await chrome.downloads.download({ url: zipUrl, filename: data.title + ".zip", saveAs: false });
      successCount++;
      console.log(`[${batchIndex}/${batchQueue.length}] 已保存: ${data.title}.zip`);

      setTimeout(() => URL.revokeObjectURL(zipUrl), 5000);
    } else {
      failCount++;
      console.log(`[${batchIndex}/${batchQueue.length}] 失败: ${data?.error || "未知错误"}`);
    }

    await chrome.tabs.remove(tab.id);
  } catch (e) {
    failCount++;
    console.log(`[${batchIndex}/${batchQueue.length}] 失败: ${e.message}`);
  }

  if (batchRunning && batchIndex < batchQueue.length) {
    setTimeout(processNext, 1000);
  } else {
    batchRunning = false;
    chrome.runtime.sendMessage({
      action: "batchComplete",
      success: successCount,
      fail: failCount,
      total: batchQueue.length,
    }).catch(() => {}); // popup 可能已关闭
  }
}

function waitForTabLoad(tabId) {
  return new Promise((resolve) => {
    const listener = (updatedTabId, changeInfo) => {
      if (updatedTabId === tabId && changeInfo.status === "complete") {
        chrome.tabs.onUpdated.removeListener(listener);
        setTimeout(resolve, 800);
      }
    };
    chrome.tabs.onUpdated.addListener(listener);
    setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      resolve();
    }, 15000);
  });
}