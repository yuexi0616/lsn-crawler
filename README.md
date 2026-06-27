# LMS 实验报告爬取

将 [LMS](http://10.30.0.135) 平台上的实验操作手册一键保存为 Markdown，支持图片下载和 ZIP 打包。

## 版本

| 版本 | 目录/文件 | 说明 |
|------|----------|------|
| **Chrome 扩展（推荐）** | `extension/` | 一键保存，无需登录，图片内嵌 |
| Node.js 脚本 | `crawl_lms.js` | 命令行批量爬取 |
| Python 脚本 | `crawl_lms.py` | 命令行批量爬取 |

## Chrome 扩展

### 安装

1. 打开 `chrome://extensions`
2. 开启右上角「开发者模式」
3. 点击「加载已解压的扩展程序」
4. 选择 `extension/` 目录

### 使用

- **保存当前页面**：打开 LMS 作业页面 → 点击右下角浮动按钮或插件图标
- **批量爬取**：点击插件图标 → 输入 Assignments 和 Module ID 范围 → 开始

输出为 ZIP 压缩包，解压后目录结构：

```
实验名称.zip
└── 实验名称/
    ├── 实验名称.md
    └── 实验名称.assets/
        ├── 实验名称_img01.png
        └── 实验名称_img02.jpg
```

## 命令行脚本

### Python

```bash
# 安装依赖
pip install requests

# 单URL爬取
python crawl_lms.py http://10.30.0.135/courses/194/assignments/2179?module_item_id=8601

# 批量爬取
python crawl_lms.py --batch 2181 2184 8603 8606

# 环境变量（可选）
set LMS_USERNAME=xxx
set LMS_PASSWORD=xxx
```

### Node.js

```bash
# 安装依赖
npm install

# 单URL爬取
node crawl_lms.js http://10.30.0.135/courses/194/assignments/2179?module_item_id=8601

# 批量爬取
node crawl_lms.js --batch 2181 2184 8603 8606
```

## 功能特性

- HTML → Markdown 转换（标题、列表、表格、代码块）
- 代码语言自动识别（Java / XML / Bash / SQL / Python / JS / Go 等 15 种）
- 图片自动下载并转为相对路径引用
- ZIP 打包下载
- 批量爬取带进度显示