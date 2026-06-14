"""
爬取 LMS 实验操作手册并保存为 Markdown。
用法:
    python crawl_lms.py <URL>
    python crawl_lms.py http://10.30.0.135/courses/194/assignments/2179?module_item_id=8601

环境变量（可选，不设置则交互输入）:
    LMS_USERNAME  登录账号
    LMS_PASSWORD  登录密码
"""

import re
import os
import sys
from html import unescape

import requests


BASE = "http://10.30.0.135"
LOGIN_URL = f"{BASE}/login/lms"


def login(session: requests.Session, username: str, password: str) -> bool:
    """登录 LMS，返回是否成功。"""
    # 先访问目标页面获取 CSRF token
    resp = session.get(f"{BASE}/courses/194", allow_redirects=True)
    resp.raise_for_status()

    # 从登录页面提取 token
    token_match = re.search(
        r'name="authenticity_token" value="([^"]+)"', resp.text
    )
    if not token_match:
        print("未找到 CSRF token，可能已登录或页面结构变化")
        return "login" not in resp.url

    token = token_match.group(1)

    resp = session.post(
        LOGIN_URL,
        data={
            "utf8": "\u2713",
            "authenticity_token": token,
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
    # 提取 user_content div
    m = re.search(
        r'class="description user_content"[^>]*>(.*?)</div>\s*</div>',
        html, re.DOTALL,
    )
    if not m:
        raise ValueError("未找到 user_content 区域")

    content = m.group(1)

    # ---- 第一步: 标记代码块区域，避免内部标签被误处理 ----
    # 处理 <pre> ... </pre>
    content = re.sub(r'<pre[^>]*>', '\n```\n', content)
    content = re.sub(r'</pre>', '\n```\n', content)

    # 处理 <code> ... </code>（pre 内部的 code 会被上面的处理覆盖，这里是行内代码）
    content = re.sub(r'<code[^>]*>', '`', content)
    content = re.sub(r'</code>', '`', content)

    # ---- 第二步: 块级元素 ----
    content = re.sub(r'<h3[^>]*>', '\n### ', content)
    content = re.sub(r'</h3>', '\n', content)
    content = re.sub(r'<h2[^>]*>', '\n## ', content)
    content = re.sub(r'</h2>', '\n', content)
    content = re.sub(r'<h1[^>]*>', '\n# ', content)
    content = re.sub(r'</h1>', '\n', content)

    content = re.sub(r'<p[^>]*>', '\n', content)
    content = re.sub(r'</p>', '\n', content)
    content = re.sub(r'<br\s*/?>', '\n', content)

    # 列表
    content = re.sub(r'<li[^>]*>', '\n- ', content)
    content = re.sub(r'</li>', '', content)
    content = re.sub(r'<ul[^>]*>', '\n', content)
    content = re.sub(r'</ul>', '\n', content)
    content = re.sub(r'<ol[^>]*>', '\n', content)
    content = re.sub(r'</ol>', '\n', content)

    # ---- 第三步: 行内元素 ----
    content = re.sub(r'<strong[^>]*>', '**', content)
    content = re.sub(r'</strong>', '**', content)
    content = re.sub(r'<b[^>]*>', '**', content)
    content = re.sub(r'</b>', '**', content)
    content = re.sub(r'<em[^>]*>', '*', content)
    content = re.sub(r'</em>', '*', content)

    # 移除 span / div 标签
    content = re.sub(r'<span[^>]*>', '', content)
    content = re.sub(r'</span>', '', content)
    content = re.sub(r'<div[^>]*>', '', content)
    content = re.sub(r'</div>', '', content)

    # 移除剩余 HTML 标签
    content = re.sub(r'<[^>]+>', '', content)

    # ---- 第四步: 解码实体 & 清洗 ----
    content = unescape(content)
    content = content.replace('\u00a0', '')    # &nbsp; → 直接删除
    content = content.replace('\u200b', '')    # 零宽空格
    # 逐行处理：空白行 → 空行
    lines = content.split('\n')
    cleaned = []
    for line in lines:
        s = line.strip()
        if s == '':
            cleaned.append('')
        else:
            cleaned.append(s)
    content = '\n'.join(cleaned)
    # 合并连续空行，但保留代码块标记前后有空行
    content = re.sub(r'\n{3,}', '\n\n', content)
    # 确保代码块前后有空行
    content = re.sub(r'([^\n])\n```', r'\1\n\n```', content)
    content = re.sub(r'```\n([^\n`])', r'```\n\n\1', content)
    content = content.strip()

    # ---- 第五步: 修复代码块格式 ----
    content = _fix_code_blocks(content)

    return content + '\n'


def _detect_lang(code: str) -> str:
    """根据代码内容猜测语言。"""
    java_kw = [
        'public class', 'import java', 'package ',
        'HBaseConfiguration', 'NamespaceDescriptor',
        'ConnectionFactory', 'HTableDescriptor', 'IOException',
    ]
    xml_kw = ['<dependency>', '<groupId>', '</dependency>']
    bash_kw = ['cd /', 'hdfs ', './start', 'namenode', '/hbase/']

    if any(kw in code for kw in java_kw):
        return 'java'
    if any(kw in code for kw in xml_kw):
        return 'xml'
    if any(kw in code for kw in bash_kw):
        return 'bash'
    return ''


def _fix_code_blocks(text: str) -> str:
    """修复 HTML 转换后残留的冗余反引号，并添加语言标注。"""
    lines = text.split('\n')
    result = []
    i = 0
    while i < len(lines):
        line = lines[i]
        stripped = line.strip()

        if stripped == '```' and i + 1 < len(lines):
            # 检查后续行是否有 backtick 包裹
            peek = i + 1
            has_wrapping = False
            while peek < len(lines) and lines[peek].strip() != '```':
                if lines[peek].strip().startswith('`'):
                    has_wrapping = True
                    break
                peek += 1

            if has_wrapping:
                code_lines = []
                i += 1
                while i < len(lines) and lines[i].strip() != '```':
                    s = lines[i]
                    stripped_s = s.strip()
                    if stripped_s.startswith('`'):
                        idx = s.find('`')
                        s = s[:idx] + s[idx + 1:]
                    if s.strip().endswith('`') and len(s.strip()) > 1:
                        idx = s.rfind('`')
                        s = s[:idx] + s[idx + 1:]
                    code_lines.append(s)
                    i += 1

                lang = _detect_lang('\n'.join(code_lines))
                result.append(f'```{lang}')
                result.extend(code_lines)
                result.append('```')
                i += 1
                continue

        result.append(line)
        i += 1

    return '\n'.join(result)


def extract_title(html: str) -> str:
    """从 HTML 提取页面标题。"""
    m = re.search(r'<title>([^<]+)</title>', html)
    if m:
        title = unescape(m.group(1)).strip()
        # 移除 LMS 后缀
        title = re.sub(r'\s*[：:]\s*LMS\s*$', '', title)
        return title
    return "实验手册"


def crawl(url: str, username: str, password: str) -> None:
    """主流程：登录 -> 抓取 -> 转换 -> 保存。"""
    session = requests.Session()
    session.headers.update({
        "User-Agent": (
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
            "AppleWebKit/537.36 (KHTML, like Gecko) "
            "Chrome/120.0.0.0 Safari/537.36"
        ),
    })

    print("[1/3] 正在登录...")
    if not login(session, username, password):
        print("登录失败，请检查账号密码")
        sys.exit(1)

    print(f"[2/3] 正在抓取: {url}")
    resp = session.get(url)
    resp.raise_for_status()
    resp.encoding = 'utf-8'

    html = resp.text
    title = extract_title(html)
    print(f"       标题: {title}")

    print("[3/3] 正在转换为 Markdown...")
    try:
        md = html_to_markdown(html)
    except ValueError as e:
        print(f"转换失败: {e}")
        sys.exit(1)

    # 生成安全文件名
    safe_name = re.sub(r'[\\/:*?"<>|]', '-', title)
    filename = f"{safe_name}.md"

    with open(filename, 'w', encoding='utf-8') as f:
        f.write(md)

    print(f"\n已保存到: {filename}")
    print(f"字符数: {len(md)}, 行数: {md.count(chr(10)) + 1}")


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(1)

    target_url = sys.argv[1]
    user = os.environ.get("LMS_USERNAME") or input("账号: ").strip()
    pwd = os.environ.get("LMS_PASSWORD") or input("密码: ").strip()

    if not user or not pwd:
        print("账号密码不能为空")
        sys.exit(1)

    crawl(target_url, user, pwd)
