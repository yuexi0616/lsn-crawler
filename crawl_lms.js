/**
 * 爬取 LMS 实验操作手册并保存为 Markdown。
 *
 * 用法:
 *   # 单URL爬取
 *   node crawl_lms.js http://10.30.0.135/courses/194/assignments/2179?module_item_id=8601
 *
 *   # 批量爬取
 *   node crawl_lms.js --batch 2181 2184 8603 8606
 *
 * 环境变量（可选，不设置则交互输入）:
 *   LMS_USERNAME  登录账号
 *   LMS_PASSWORD  登录密码
 */

import fs from "node:fs";
import readline from "node:readline";
import * as cheerio from "cheerio";
import he from "he";
const { decode } = he;
import axios from "axios";
import { Command } from "commander";

// ============================================================
// 常量
// ============================================================
const BASE = "http://10.30.0.135";
const LOGIN_URL = `${BASE}/login/lms`;
const COURSE_URL = `${BASE}/courses/194`;
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

const RETRY_STATUSES = [429, 500, 502, 503, 504];
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 1000;

// 语言检测关键词
const JAVA_KW = [
  "public class", "import java", "package ",
  "HBaseConfiguration", "NamespaceDescriptor",
  "ConnectionFactory", "HTableDescriptor", "IOException",
];
const XML_KW = ["<dependency>", "<groupId>", "</dependency>"];
const BASH_KW = ["cd /", "hdfs ", "./start", "namenode", "/hbase/"];

// 文件名安全字符正则
const RE_SAFE_FILENAME = /[\\/:*?"<>|]/g;
// LMS 标题后缀
const RE_LMS_SUFFIX = /\s*[：:]\s*LMS\s*$/;

// ============================================================
// HTTP 客户端（带重试）
// ============================================================

/** 创建带重试的 axios 实例 */
function createClient() {
  const client = axios.create({
    headers: { "User-Agent": USER_AGENT },
    maxRedirects: 5,
    timeout: 30000,
  });

  client.interceptors.response.use(
    (res) => res,
    async (err) => {
      const config = err.config;
      config.__retryCount = config.__retryCount ?? 0;

      if (
        config.__retryCount < MAX_RETRIES &&
        (err.response && RETRY_STATUSES.includes(err.response.status))
      ) {
        config.__retryCount++;
        const delay = RETRY_DELAY_MS * Math.pow(2, config.__retryCount - 1);
        console.log(`  [重试 ${config.__retryCount}/${MAX_RETRIES}] ${delay}ms 后重试...`);
        await new Promise((r) => setTimeout(r, delay));
        return client(config);
      }
      return Promise.reject(err);
    },
  );

  return client;
}

// ============================================================
// 登录
// ============================================================
/**
 * 登录 LMS
 * @param {import("axios").AxiosInstance} client
 * @param {string} username
 * @param {string} password
 * @returns {Promise<boolean>}
 */
async function login(client, username, password) {
  const resp = await client.get(COURSE_URL, { maxRedirects: 0, validateStatus: (s) => s < 400 });
  const html = resp.data;

  // 提取 CSRF token
  const tokenMatch = html.match(/name="authenticity_token" value="([^"]+)"/);
  if (!tokenMatch) {
    console.log("未找到 CSRF token，可能已登录或页面结构变化");
    return !resp.request?.res?.responseUrl?.includes("login");
  }

  const formData = new URLSearchParams();
  formData.append("utf8", "\u2713");
  formData.append("authenticity_token", tokenMatch[1]);
  formData.append("redirect_to_ssl", "1");
  formData.append("pseudonym_session[unique_id]", username);
  formData.append("pseudonym_session[password]", password);
  formData.append("pseudonym_session[remember_me]", "0");

  const loginResp = await client.post(LOGIN_URL, formData, {
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    maxRedirects: 0,
    validateStatus: (s) => s < 400,
  });

  return !loginResp.data.slice(-2000).includes("登录");
}

// ============================================================
// HTML → Markdown 转换
// ============================================================

/**
 * 将 user_content 区域的 HTML 转为 Markdown
 * @param {string} html - 完整页面 HTML
 * @returns {string}
 */
function htmlToMarkdown(html) {
  const $ = cheerio.load(html);
  const userContent = $(".description.user_content");
  if (!userContent.length) {
    throw new Error("未找到 user_content 区域");
  }

  // 克隆节点以避免修改原始 DOM
  const $content = cheerio.load(userContent.html() ?? "", { decodeEntities: false });

  const root = $content.root();

  // --- 第一步: 预处理代码块（优先处理，避免内部标签被误处理）---
  root.find("pre").each((_, el) => {
    $content(el).replaceWith(`\n\`\`\`\n${$content(el).html()}\n\`\`\`\n`);
  });
  root.find("code").each((_, el) => {
    const $el = $content(el);
    // 跳过 pre 内部的 code（已被 pre 处理）
    if ($el.parent().is("pre")) return;
    $el.replaceWith(`\`${$el.text()}\``);
  });

  // --- 第二步: 块级元素 ---
  for (let i = 1; i <= 6; i++) {
    const tag = `h${i}`;
    const prefix = "#".repeat(i);
    root.find(tag).each((_, el) => {
      $content(el).replaceWith(`\n${prefix} ${$content(el).text()}\n`);
    });
  }

  root.find("p").each((_, el) => {
    $content(el).replaceWith(`\n${$content(el).text()}\n`);
  });
  root.find("br").replaceWith("\n");

  // 列表
  root.find("li").each((_, el) => {
    $content(el).replaceWith(`\n- ${$content(el).text()}`);
  });
  root.find("ul, ol").each((_, el) => {
    $content(el).replaceWith(`\n${$content(el).html()}\n`);
  });

  // --- 第三步: 行内元素 ---
  root.find("strong, b").each((_, el) => {
    $content(el).replaceWith(`**${$content(el).text()}**`);
  });
  root.find("em, i").each((_, el) => {
    $content(el).replaceWith(`*${$content(el).text()}*`);
  });

  // 移除 span / div（保留内部文本）
  root.find("span, div").each((_, el) => {
    $content(el).replaceWith($content(el).text());
  });

  // --- 第四步: 提取纯文本并清洗 ---
  let text = $content.text();

  // 解码 HTML 实体
  text = decode(text, { isAttributeValue: false });
  // 移除特殊空白字符
  text = text.replace(/\u00a0/g, "").replace(/\u200b/g, "");

  // 逐行 trim
  text = text
    .split("\n")
    .map((line) => line.trim())
    .join("\n");

  // 合并连续空行
  text = text.replace(/\n{3,}/g, "\n\n");
  // 确保代码块前后有空行
  text = text.replace(/([^\n])\n```/g, "$1\n\n```");
  text = text.replace(/```\n([^\n`])/g, "```\n\n$1");
  text = text.trim();

  // --- 第五步: 修复代码块格式 ---
  text = fixCodeBlocks(text);

  return text + "\n";
}

// ============================================================
// 代码块修复 & 语言检测
// ============================================================

/** @param {string} code */
function detectLang(code) {
  if (JAVA_KW.some((kw) => code.includes(kw))) return "java";
  if (XML_KW.some((kw) => code.includes(kw))) return "xml";
  if (BASH_KW.some((kw) => code.includes(kw))) return "bash";
  return "";
}

/**
 * 修复 HTML 转换后残留的冗余反引号，并添加语言标注
 * @param {string} text
 * @returns {string}
 */
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

    // 找闭合的 ```
    let end = i + 1;
    while (end < n && lines[end].trim() !== "```") {
      end++;
    }

    if (end >= n) {
      // 未闭合，原样保留
      result.push(line);
      i++;
      continue;
    }

    const codeLines = lines.slice(i + 1, end);
    const hasWrapping = codeLines.some((cl) => cl.trim().startsWith("`"));

    if (hasWrapping) {
      // 去除每行首尾的反引号
      const cleaned = codeLines.map((cl) => {
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
      const lang = detectLang(cleaned.join("\n"));
      result.push(`\`\`\`${lang}`);
      result.push(...cleaned);
      result.push("```");
    } else {
      result.push(line);
      result.push(...codeLines);
      result.push(lines[end]);
    }

    i = end + 1;
  }

  return result.join("\n");
}

// ============================================================
// 标题提取
// ============================================================
/** @param {string} html */
function extractTitle(html) {
  const $ = cheerio.load(html);
  let title = $("title").text().trim();
  if (title) {
    title = title.replace(RE_LMS_SUFFIX, "");
    return title;
  }
  return "实验手册";
}

// ============================================================
// 爬取流程
// ============================================================
/**
 * 爬取单个 URL 并保存为 Markdown
 * @param {import("axios").AxiosInstance} client
 * @param {string} url
 * @param {number} [index]
 * @param {number} [total]
 * @returns {Promise<boolean>}
 */
async function crawlSingleUrl(client, url, index, total) {
  const prefix = index && total ? `[${index}/${total}] ` : "";
  try {
    console.log(`\n${prefix}正在抓取: ${url}`);
    const resp = await client.get(url);
    const html = resp.data;

    const title = extractTitle(html);
    console.log(`${prefix}标题: ${title}`);

    const md = htmlToMarkdown(html);

    const safeName = title.replace(RE_SAFE_FILENAME, "-");
    const filename = `${safeName}.md`;

    fs.writeFileSync(filename, md, "utf-8");
    console.log(`${prefix}已保存: ${filename}  (${md.length} 字符, ${md.split("\n").length} 行)`);
    return true;
  } catch (err) {
    console.error(`${prefix}失败: ${err.message}`);
    return false;
  }
}

/**
 * 根据范围生成批量 URL 列表
 * @param {number} startAssign
 * @param {number} endAssign
 * @param {number} startModule
 * @param {number} endModule
 * @returns {string[]}
 */
function generateBatchUrls(startAssign, endAssign, startModule, endModule) {
  const assignCount = endAssign - startAssign + 1;
  const moduleCount = endModule - startModule + 1;
  if (assignCount !== moduleCount || assignCount <= 0) {
    throw new Error("assignments 范围和 module_item_id 范围的数量不匹配，或范围无效");
  }
  return Array.from({ length: assignCount }, (_, i) => {
    return `${BASE}/courses/194/assignments/${startAssign + i}?module_item_id=${startModule + i}`;
  });
}

// ============================================================
// 交互输入
// ============================================================
/** @param {string} prompt */
function ask(prompt) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(prompt, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

// ============================================================
// 入口
// ============================================================
async function main() {
  const program = new Command();

  program
    .name("node crawl_lms.js")
    .description("爬取 LMS 实验操作手册并保存为 Markdown")
    .argument("[url]", "单个目标 URL")
    .option("--batch <startAssign> <endAssign> <startModule> <endModule>", "批量模式")
    .addHelpText(
      "after",
      "\n示例:\n  node crawl_lms.js http://10.30.0.135/.../2179?module_item_id=8601\n  node crawl_lms.js --batch 2181 2184 8603 8606",
    );

  program.parse();
  const opts = program.opts();
  const args = program.args;

  const batchArgs = typeof opts.batch === "string"
    ? opts.batch.split(/\s+/).filter(Boolean).map(Number)
    : opts.batch;

  if (!args[0] && !batchArgs) {
    program.help();
    return;
  }

  // 获取凭据
  const username = process.env.LMS_USERNAME || (await ask("账号: "));
  const password = process.env.LMS_PASSWORD || (await ask("密码: "));
  if (!username || !password) {
    console.log("账号密码不能为空");
    process.exit(1);
  }

  // 登录
  const client = createClient();
  console.log("正在登录...");
  const ok = await login(client, username, password);
  if (!ok) {
    console.log("登录失败，请检查账号密码");
    process.exit(1);
  }
  console.log("登录成功！");

  // 处理请求
  if (batchArgs && batchArgs.length === 4) {
    const [startAssign, endAssign, startModule, endModule] = batchArgs;
    let urls;
    try {
      urls = generateBatchUrls(startAssign, endAssign, startModule, endModule);
    } catch (e) {
      console.log(`生成 URL 失败: ${e.message}`);
      process.exit(1);
    }

    console.log(`\n共 ${urls.length} 个 URL 待爬取:`);
    urls.forEach((u, i) => console.log(`  ${i + 1}. ${u}`));

    let success = 0;
    let fail = 0;
    const total = urls.length;
    for (let i = 0; i < total; i++) {
      const result = await crawlSingleUrl(client, urls[i], i + 1, total);
      if (result) success++;
      else fail++;
    }

    console.log(`\n批量爬取完成: 成功 ${success}, 失败 ${fail}, 总计 ${total}`);
  } else {
    await crawlSingleUrl(client, args[0]);
  }
}

main().catch((err) => {
  console.error("未预期的错误:", err.message);
  process.exit(1);
});