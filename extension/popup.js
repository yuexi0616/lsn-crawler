/**
 * popup.js — 弹出窗口逻辑
 * 使用 chrome.scripting.executeScript 直接注入代码，不依赖 content script 预加载
 */

const el = (id) => document.getElementById(id);

// ============================================================
// 注入到目标页面的提取函数（作为普通函数传给 executeScript）
// ============================================================
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
  if (!userContent) return { ok: false, error: "未找到 .description.user_content 元素" };

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
      // 从 dataUrl 推断扩展名
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
// 检查当前页面
// ============================================================
async function checkCurrentPage() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !tab.url) {
      el("pageInfo").textContent = "无法获取当前页面";
      el("pageInfo").className = "status";
      return;
    }

    const url = tab.url.toLowerCase();
    if (!url.includes("10.30.0.135")) {
      el("pageInfo").textContent = "当前页面不是 LMS 网站 (10.30.0.135)";
      el("pageInfo").className = "status";
      el("btnSaveCurrent").disabled = true;
      return;
    }

    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => {
        const el = document.querySelector(".description.user_content");
        return {
          hasContent: !!el,
          title: document.title.trim().replace(/\s*[：:]\s*LMS\s*$/, ""),
        };
      },
    });

    const info = results?.[0]?.result;
    if (info?.hasContent) {
      el("pageInfo").textContent = "标题: " + info.title;
      el("pageInfo").className = "status success";
      el("btnSaveCurrent").disabled = false;
    } else {
      el("pageInfo").textContent = "当前页面不是作业页面（未找到 .description.user_content）";
      el("pageInfo").className = "status";
      el("btnSaveCurrent").disabled = true;
    }
  } catch (e) {
    el("pageInfo").textContent = "请先打开 LMS 页面再点击插件";
    el("pageInfo").className = "status";
    el("btnSaveCurrent").disabled = true;
  }
}

// ============================================================
// 保存当前页面
// ============================================================
el("btnSaveCurrent").addEventListener("click", async () => {
  const btn = el("btnSaveCurrent");
  btn.disabled = true;
  btn.textContent = "正在保存...";

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: extractPage,
    });

    const data = results?.[0]?.result;
    if (!data?.ok) {
      throw new Error(data?.error || "提取失败");
    }

    // 用 JSZip 打包
    const zip = new JSZip();
    const folder = zip.folder(data.title);
    const imgFolder = folder.folder(data.title + "_files");

    folder.file(data.title + ".md", data.md + "\n");
    for (const img of (data.images || [])) {
      // dataUrl 格式: "data:image/png;base64,xxxx"
      const base64 = img.dataUrl.split(",")[1];
      imgFolder.file(img.filename, base64, { base64: true });
    }

    const zipBlob = await zip.generateAsync({ type: "blob" });
    const zipUrl = URL.createObjectURL(zipBlob);

    await chrome.downloads.download({
      url: zipUrl,
      filename: data.title + ".zip",
      saveAs: false,
    });

    // 延迟释放 blob URL
    setTimeout(() => URL.revokeObjectURL(zipUrl), 5000);

    btn.textContent = "已保存: " + data.title + ".zip";
    btn.style.background = "#16a34a";
  } catch (e) {
    btn.textContent = "失败: " + e.message;
    btn.style.background = "#dc2626";
  }
  setTimeout(() => {
    btn.textContent = "保存当前页面为 Markdown";
    btn.style.background = "";
    btn.disabled = false;
  }, 2500);
});

// ============================================================
// 批量爬取
// ============================================================
el("btnStartBatch").addEventListener("click", async () => {
  const startAssign = parseInt(el("batchStartAssign").value);
  const endAssign = parseInt(el("batchEndAssign").value);
  const startModule = parseInt(el("batchStartModule").value);
  const endModule = parseInt(el("batchEndModule").value);

  if ([startAssign, endAssign, startModule, endModule].some(isNaN)) {
    el("batchStatus").textContent = "请填写完整的范围";
    el("batchStatus").className = "status error";
    return;
  }

  const resp = await chrome.runtime.sendMessage({
    action: "startBatch",
    startAssign,
    endAssign,
    startModule,
    endModule,
  });

  if (!resp.success) {
    el("batchStatus").textContent = resp.error;
    el("batchStatus").className = "status error";
    return;
  }

  el("btnStartBatch").style.display = "none";
  el("btnStopBatch").style.display = "block";
  el("progressBar").style.display = "block";
  el("batchStatus").textContent = `准备爬取 ${resp.total} 个页面...`;
  el("batchStatus").className = "status";

  pollBatchStatus(resp.total);
});

el("btnStopBatch").addEventListener("click", async () => {
  await chrome.runtime.sendMessage({ action: "stopBatch" });
  resetBatchUI();
});

// ============================================================
// 批量状态轮询
// ============================================================
let pollTimer = null;

async function pollBatchStatus(total) {
  const status = await chrome.runtime.sendMessage({ action: "getBatchStatus" });
  if (!status || !status.running) {
    resetBatchUI();
    return;
  }

  const pct = total > 0 ? Math.round((status.current / total) * 100) : 0;
  el("progressFill").style.width = pct + "%";
  el("batchStatus").textContent =
    `进度: ${status.current}/${total} | 成功: ${status.success} | 失败: ${status.fail}`;

  pollTimer = setTimeout(() => pollBatchStatus(total), 1000);
}

function resetBatchUI() {
  clearTimeout(pollTimer);
  el("btnStartBatch").style.display = "block";
  el("btnStopBatch").style.display = "none";
  el("progressBar").style.display = "none";
  el("progressFill").style.width = "0%";
}

// ============================================================
// 监听 background 完成通知
// ============================================================
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.action === "batchComplete") {
    el("batchStatus").textContent =
      `完成! 成功: ${msg.success}, 失败: ${msg.fail}, 总计: ${msg.total}`;
    el("batchStatus").className = msg.fail === 0 ? "status success" : "status error";
    resetBatchUI();
  }
});

// ============================================================
// 初始化
// ============================================================
checkCurrentPage();