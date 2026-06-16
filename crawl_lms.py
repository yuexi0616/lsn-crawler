"""
爬取 LMS 实验操作手册并保存为 Markdown。

用法:
    # 单URL爬取
    python crawl_lms.py http://10.30.0.135/courses/194/assignments/2179?module_item_id=8601

    # 批量爬取
    python crawl_lms.py --batch 2181 2184 8603 8606

环境变量（可选，不设置则交互输入）:
    LMS_USERNAME  登录账号
    LMS_PASSWORD  登录密码
"""

import re
import os
import sys
import argparse
from html import unescape
from typing import Optional

import requests
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry

# ============================================================
# 常量
# ============================================================
BASE = "http://10.30.0.135"
LOGIN_URL = f"{BASE}/login/lms"
COURSE_URL = f"{BASE}/courses/194"
USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/120.0.0.0 Safari/537.36"
)

# ============================================================
# 预编译正则（避免每次调用重复编译）
# ============================================================
_RE_CSRF_TOKEN = re.compile(r'name="authenticity_token" value="([^"]+)"')
_RE_USER_CONTENT = re.compile(
    r'class="description user_content"[^>]*>(.*?)</div>\s*</div>', re.DOTALL
)
_RE_PRE_OPEN = re.compile(r"<pre[^>]*>")
_RE_PRE_CLOSE = re.compile(r"</pre>")
_RE_CODE_OPEN = re.compile(r"<code[^>]*>")
_RE_CODE_CLOSE = re.compile(r"</code>")
_RE_H_OPEN = re.compile(r"<h(\d)[^>]*>")
_RE_H_CLOSE = re.compile(r"</h(\d)>")
_RE_P_OPEN = re.compile(r"<p[^>]*>")
_RE_P_CLOSE = re.compile(r"</p>")
_RE_BR = re.compile(r"<br\s*/?>")
_RE_LI_OPEN = re.compile(r"<li[^>]*>")
_RE_LI_CLOSE = re.compile(r"</li>")
_RE_UL_OPEN = re.compile(r"<ul[^>]*>")
_RE_UL_CLOSE = re.compile(r"</ul>")
_RE_OL_OPEN = re.compile(r"<ol[^>]*>")
_RE_OL_CLOSE = re.compile(r"</ol>")
_RE_STRONG_OPEN = re.compile(r"<strong[^>]*>")
_RE_STRONG_CLOSE = re.compile(r"</strong>")
_RE_B_OPEN = re.compile(r"<b[^>]*>")
_RE_B_CLOSE = re.compile(r"</b>")
_RE_EM_OPEN = re.compile(r"<em[^>]*>")
_RE_EM_CLOSE = re.compile(r"</em>")
_RE_SPAN_OPEN = re.compile(r"<span[^>]*>")
_RE_SPAN_CLOSE = re.compile(r"</span>")
_RE_DIV_OPEN = re.compile(r"<div[^>]*>")
_RE_DIV_CLOSE = re.compile(r"</div>")
_RE_REMAINING_TAG = re.compile(r"<[^>]+>")
_RE_MULTI_NEWLINE = re.compile(r"\n{3,}")
_RE_CODEBLOCK_PRE = re.compile(r"([^\n])\n```")
_RE_CODEBLOCK_POST = re.compile(r"```\n([^\n`])")
_RE_TITLE = re.compile(r"<title>([^<]+)</title>")
_RE_LMS_SUFFIX = re.compile(r"\s*[：:]\s*LMS\s*$")
_RE_SAFE_FILENAME = re.compile(r'[\\/:*?"<>|]')

# 语言检测关键词（编译为元组避免每次重建列表）
_JAVA_KW = (
    "public class", "import java", "package ",
    "HBaseConfiguration", "NamespaceDescriptor",
    "ConnectionFactory", "HTableDescriptor", "IOException",
)
_XML_KW = ("<dependency>", "<groupId>", "</dependency>")
_BASH_KW = ("cd /", "hdfs ", "./start", "namenode", "/hbase/")


# ============================================================
# 工具函数
# ============================================================
def build_session() -> requests.Session:
    """创建带重试机制的 Session。"""
    session = requests.Session()
    session.headers.update({"User-Agent": USER_AGENT})

    # 配置重试：最多3次，指数退避
    retry_strategy = Retry(
        total=3,
        backoff_factor=1,
        status_forcelist=[429, 500, 502, 503, 504],
        allowed_methods=["GET", "POST"],
    )
    adapter = HTTPAdapter(max_retries=retry_strategy)
    session.mount("http://", adapter)
    return session


# ============================================================
# 核心逻辑
# ============================================================
def login(session: requests.Session, username: str, password: str) -> bool:
    """登录 LMS，返回是否成功。"""
    resp = session.get(COURSE_URL, allow_redirects=True)
    resp.raise_for_status()

    token_match = _RE_CSRF_TOKEN.search(resp.text)
    if not token_match:
        print("未找到 CSRF token，可能已登录或页面结构变化")
        return "login" not in resp.url

    resp = session.post(
        LOGIN_URL,
        data={
            "utf8": "\u2713",
            "authenticity_token": token_match.group(1),
            "redirect_to_ssl": "1",
            "pseudonym_session[unique_id]": username,
            "pseudonym_session[password]": password,
            "pseudonym_session[remember_me]": "0",
        },
        allow_redirects=True,
    )
    resp.raise_for_status()
    return "登录" not in resp.text[-2000:]


def html_to_markdown(html: str) -> str:
    """将 user_content 区域的 HTML 转为 Markdown。"""
    m = _RE_USER_CONTENT.search(html)
    if not m:
        raise ValueError("未找到 user_content 区域")

    content = m.group(1)

    # 第一步: 代码块区域（优先级最高，避免内部标签被误处理）
    content = _RE_PRE_OPEN.sub("\n```\n", content)
    content = _RE_PRE_CLOSE.sub("\n```\n", content)
    content = _RE_CODE_OPEN.sub("`", content)
    content = _RE_CODE_CLOSE.sub("`", content)

    # 第二步: 块级元素
    content = _RE_H_OPEN.sub(r"\n#\1 ", content)
    content = _RE_H_CLOSE.sub("\n", content)
    content = _RE_P_OPEN.sub("\n", content)
    content = _RE_P_CLOSE.sub("\n", content)
    content = _RE_BR.sub("\n", content)
    content = _RE_LI_OPEN.sub("\n- ", content)
    content = _RE_LI_CLOSE.sub("", content)
    content = _RE_UL_OPEN.sub("\n", content)
    content = _RE_UL_CLOSE.sub("\n", content)
    content = _RE_OL_OPEN.sub("\n", content)
    content = _RE_OL_CLOSE.sub("\n", content)

    # 第三步: 行内元素
    content = _RE_STRONG_OPEN.sub("**", content)
    content = _RE_STRONG_CLOSE.sub("**", content)
    content = _RE_B_OPEN.sub("**", content)
    content = _RE_B_CLOSE.sub("**", content)
    content = _RE_EM_OPEN.sub("*", content)
    content = _RE_EM_CLOSE.sub("*", content)

    # 移除 span / div 标签
    content = _RE_SPAN_OPEN.sub("", content)
    content = _RE_SPAN_CLOSE.sub("", content)
    content = _RE_DIV_OPEN.sub("", content)
    content = _RE_DIV_CLOSE.sub("", content)

    # 移除剩余 HTML 标签
    content = _RE_REMAINING_TAG.sub("", content)

    # 第四步: 解码实体 & 清洗
    content = unescape(content)
    content = content.replace("\u00a0", "")
    content = content.replace("\u200b", "")

    # 逐行 trim
    lines = [line.strip() for line in content.split("\n")]
    content = "\n".join(lines)

    # 合并连续空行
    content = _RE_MULTI_NEWLINE.sub("\n\n", content)
    # 确保代码块前后有空行
    content = _RE_CODEBLOCK_PRE.sub(r"\1\n\n```", content)
    content = _RE_CODEBLOCK_POST.sub(r"```\n\n\1", content)
    content = content.strip()

    # 第五步: 修复代码块格式
    content = _fix_code_blocks(content)

    return content + "\n"


def _detect_lang(code: str) -> str:
    """根据代码内容猜测语言。"""
    if any(kw in code for kw in _JAVA_KW):
        return "java"
    if any(kw in code for kw in _XML_KW):
        return "xml"
    if any(kw in code for kw in _BASH_KW):
        return "bash"
    return ""


def _fix_code_blocks(text: str) -> str:
    """修复 HTML 转换后残留的冗余反引号，并添加语言标注。"""
    lines = text.split("\n")
    result: list[str] = []
    i = 0
    n = len(lines)

    while i < n:
        line = lines[i]

        if line.strip() != "```" or i + 1 >= n:
            result.append(line)
            i += 1
            continue

        # 找到下一个 ``` 的位置
        end = i + 1
        while end < n and lines[end].strip() != "```":
            end += 1

        if end >= n:
            # 未闭合的代码块，原样保留
            result.append(line)
            i += 1
            continue

        # 检查代码块内是否有反引号包裹
        code_lines = lines[i + 1 : end]
        has_wrapping = any(cl.strip().startswith("`") for cl in code_lines)

        if has_wrapping:
            # 去除每行的首尾反引号
            cleaned = []
            for cl in code_lines:
                s = cl
                stripped = s.strip()
                if stripped.startswith("`"):
                    idx = s.find("`")
                    s = s[:idx] + s[idx + 1 :]
                if s.strip().endswith("`") and len(s.strip()) > 1:
                    idx = s.rfind("`")
                    s = s[:idx] + s[idx + 1 :]
                cleaned.append(s)
            lang = _detect_lang("\n".join(cleaned))
            result.append(f"```{lang}")
            result.extend(cleaned)
            result.append("```")
        else:
            result.append(line)
            result.extend(code_lines)
            result.append(lines[end])

        i = end + 1

    return "\n".join(result)


def extract_title(html: str) -> str:
    """从 HTML 提取页面标题。"""
    m = _RE_TITLE.search(html)
    if m:
        title = unescape(m.group(1)).strip()
        title = _RE_LMS_SUFFIX.sub("", title)
        return title
    return "实验手册"


# ============================================================
# 爬取流程
# ============================================================
def crawl_single_url(session: requests.Session, url: str, index: Optional[int] = None, total: Optional[int] = None) -> bool:
    """爬取单个 URL 并保存为 Markdown。返回是否成功。"""
    prefix = f"[{index}/{total}] " if index and total else ""
    try:
        print(f"\n{prefix}正在抓取: {url}")
        resp = session.get(url, timeout=30)
        resp.raise_for_status()
        resp.encoding = "utf-8"

        html = resp.text
        title = extract_title(html)
        print(f"{prefix}标题: {title}")

        md = html_to_markdown(html)

        safe_name = _RE_SAFE_FILENAME.sub("-", title)
        filename = f"{safe_name}.md"

        with open(filename, "w", encoding="utf-8") as f:
            f.write(md)

        print(f"{prefix}已保存: {filename}  ({len(md)} 字符, {md.count(chr(10)) + 1} 行)")
        return True
    except Exception as e:
        print(f"{prefix}失败: {e}")
        return False


def generate_batch_urls(
    start_assign: int, end_assign: int, start_module: int, end_module: int
) -> list[str]:
    """根据范围生成批量 URL 列表。"""
    assign_count = end_assign - start_assign + 1
    module_count = end_module - start_module + 1
    if assign_count != module_count or assign_count <= 0:
        raise ValueError("assignments 范围和 module_item_id 范围的数量不匹配，或范围无效")

    return [
        f"{BASE}/courses/194/assignments/{start_assign + i}?module_item_id={start_module + i}"
        for i in range(assign_count)
    ]


# ============================================================
# 入口
# ============================================================
def main() -> None:
    parser = argparse.ArgumentParser(
        description="爬取 LMS 实验操作手册并保存为 Markdown",
        epilog="示例:\n"
               "  python crawl_lms.py http://10.30.0.135/.../2179?module_item_id=8601\n"
               "  python crawl_lms.py --batch 2181 2184 8603 8606",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument("url", nargs="?", help="单个目标 URL")
    parser.add_argument("--batch", nargs=4, type=int, metavar=("START_ASSIGN", "END_ASSIGN", "START_MODULE", "END_MODULE"),
                        help="批量模式：assignments 和 module_item_id 的起止范围")

    args = parser.parse_args()

    if not args.url and not args.batch:
        parser.print_help()
        sys.exit(1)

    # 获取凭据
    user = os.environ.get("LMS_USERNAME") or input("账号: ").strip()
    pwd = os.environ.get("LMS_PASSWORD") or input("密码: ").strip()
    if not user or not pwd:
        print("账号密码不能为空")
        sys.exit(1)

    # 登录
    session = build_session()
    print("正在登录...")
    if not login(session, user, pwd):
        print("登录失败，请检查账号密码")
        sys.exit(1)
    print("登录成功！")

    # 处理请求
    if args.batch:
        start_assign, end_assign, start_module, end_module = args.batch
        try:
            urls = generate_batch_urls(start_assign, end_assign, start_module, end_module)
        except ValueError as e:
            print(f"生成 URL 失败: {e}")
            sys.exit(1)

        print(f"\n共 {len(urls)} 个 URL 待爬取:\n" + "\n".join(f"  {i}. {u}" for i, u in enumerate(urls, 1)))

        success = 0
        fail = 0
        total = len(urls)
        for i, url in enumerate(urls, 1):
            if crawl_single_url(session, url, index=i, total=total):
                success += 1
            else:
                fail += 1

        print(f"\n批量爬取完成: 成功 {success}, 失败 {fail}, 总计 {total}")
    else:
        crawl_single_url(session, args.url)


if __name__ == "__main__":
    main()