# LMS 实验手册爬取工具

这是一个用于爬取 LMS 平台实验操作手册并转换为 Markdown 格式的 Python 工具，支持单 URL 爬取和批量 URL 爬取两种模式。

---

## 📦 环境依赖

本项目基于 Python 3 开发，运行前请确保安装以下依赖：

```bash
pip install requests
```

## 🚀 使用说明

### 1. 单 URL 爬取（`crawl_lms.py`）

适合单个实验手册的快速爬取。

```bash
python crawl_lms.py "目标LMS页面URL"
```

**示例：**

```bash
python crawl_lms.py "http://10.30.0.135/courses/194/assignments/2179?module_item_id=8601"
```

### 2. 批量 URL 爬取（`new_crawl_lms.py`）

适合批量爬取多个实验手册，支持按范围批量获取任务。

```bash
python new_crawl_lms.py --batch <start_assign> <end_assign> <start_module> <end_module>
```

**示例：**

```bash
python new_crawl_lms.py --batch 2181 2184 8603 8606
```

## 📁 文件说明

| 文件名             | 功能描述                                              |
| ------------------ | ----------------------------------------------------- |
| `crawl_lms.py`     | 基础版本，仅支持单 URL 爬取，适合快速获取单个实验手册 |
| `new_crawl_lms.py` | 增强版本，支持批量爬取，可按任务和模块范围批量处理    |

## ⚠️ 注意事项

1. 请确保你拥有访问目标 LMS 平台的合法权限，本工具仅用于个人学习与实验用途。
2. 部分页面可能需要登录权限，若爬取失败请检查账号登录状态或 Cookie 配置。
3. 爬取频率过高可能触发平台反爬机制，建议批量爬取时适当增加请求间隔。
4. 生成的 Markdown 文件默认保存在当前目录下，可根据需要修改脚本中的保存路径。