<div align="center">

# 枝记 ZhiNote

**轻量级树形 Markdown 笔记 · 单 HTML 文件 · WebDAV 端到端加密同步 · 多端通用**

[在线使用](https://app.zhinote.net) · [Quicker 桌面版](https://getquicker.net/Sharedaction?code=b5091d78-12cc-4fb9-bd01-08debb8a5d21&fromMyShare=true) · [自托管](#自托管部署)

`Markdown 所见即所得` · `WebDAV 同步` · `AES-256 加密` · `离线可用 PWA`

</div>

---

## 这是什么

枝记是一款**整个应用只有一个 HTML 文件**的 Markdown 笔记工具：

- **数据完全归你**：笔记保存在浏览器本地（IndexedDB），同步走你自己的 WebDAV 网盘，**没有任何官方服务器**，作者跑路也不影响使用
- **端到端加密**：笔记上传前用 AES-256-GCM 加密（可自设口令），网盘服务商看不到内容
- **多端通用**：电脑浏览器、手机、平板打开同一地址即可；支持安装为 PWA 应用，离线可用
- **部署 = 复制一个文件**：丢到任何静态网页服务（群晖 Web Station、Nginx、Cloudflare Pages、Docker…）就能跑

## 功能一览

| | |
|---|---|
| **富文本编辑** | 标题、粗体、高亮、引用、代码块、列表、表格等完整 Markdown 语法，所见即所得（TipTap 内核），存储为标准 Markdown |
| **数学公式** | 行内/块级公式，可视化符号面板，KaTeX 渲染 |
| **图片管理** | 拖拽/粘贴插入、缩放、浮动排版、图库浏览、随笔记加密同步 |
| **树形笔记 + 多笔记本** | 无限层级嵌套、拖拽排序、置顶、工作区隔离 |
| **WebDAV 同步** | 坚果云 / Koofr / InfiniCLOUD / Nextcloud / 群晖等任意标准 WebDAV；三方合并、冲突留底、绝不悄悄丢数据 |
| **挖空复习** | 选中文字标记挖空，复习时遮盖、点击揭示，适合背诵记忆 |
| **大纲 / 搜索 / 命令面板** | 标题自动成大纲；全文检索；Ctrl+P 键盘直达所有操作 |
| **触屏适配** | 双指手势（滑动切换、轻点菜单、捏合调字号）、键盘工具条、选中浮动工具条 |
| **主题 / 模板 / 定时备份** | 多套明暗主题实时预览；笔记模板；本地 JSON 定时备份 |

## 快速开始

### 直接用

浏览器打开 **<https://app.zhinote.net>**，即开即用。建议顺手在 设置 → 同步 里配一个免费 WebDAV（界面里有各家网盘的图文教程），数据就有了云端保险。

> 手机/平板：浏览器菜单「添加到主屏幕 / 安装应用」，独立窗口运行，体验接近原生 App。

### 自托管部署

枝记没有后端，自托管就是托管一个静态文件，任选其一：

**方式一：单文件**

下载 [`dist/ZhiNote.html`](dist/ZhiNote.html)，放到任何能提供静态网页的地方（群晖 Web Station、宝塔、Nginx、IIS…），完事。

**方式二：完整 PWA（含离线缓存与桌面安装支持）**

把 [`dist/web/`](dist/web) 整个文件夹部署为站点根目录（Cloudflare Pages / Netlify / Vercel / GitHub Pages 都行）。

**方式三：Docker**

```bash
# 直接用现成镜像（随仓库自动更新）
docker run -d --name zhinote -p 8080:80 ghcr.io/daloudalou/zhinote:latest

# 或从源码自行构建
docker build -t zhinote .
docker run -d --name zhinote -p 8080:80 zhinote
# 打开 http://localhost:8080
```

> **关于同步代理**：浏览器有跨域限制，网页端连 WebDAV 需经代理转发（Quicker 桌面端直连，无需代理）。内置默认代理开箱即用（共用配额；不支持坚果云）；强烈建议自建专属代理——免费、五分钟搞定，应用内 设置 → 同步 有完整教程。

## 从源码构建

```bash
node publish.mjs        # 产出 发布版本/vX.Y.Z/ZhiNote.html 与 web/ 目录
```

无任何 npm 依赖，只需要 Node.js。`src/` 即全部源码（未压缩、含中文注释），构建只是把 CSS/JS 原样内联进一个 HTML。

```
src/
├── index.html          # 应用骨架
├── app.js              # UI 编排：设置、弹窗、同步状态、手势
├── editor.js           # TipTap 编辑器与 Markdown 扩展
├── storage.js          # 本地持久化（IndexedDB / 分片存储 / 图片外置）
├── webdav-sync.js      # WebDAV 同步引擎（加密、三方合并、冲突留底、限流退避）
├── tree.js / search.js / palette.js / template.js
├── styles.css          # 全部样式（多主题）
└── sw.js               # Service Worker（离线缓存）
```

## 数据安全设计

- 笔记内容为标准 Markdown 文本（存储容器为 JSON），随时可整库导出为 `.md` 文件树或 JSON 备份，无任何格式锁定
- 同步采用三方合并 + 冲突副本 + 覆盖前留底，任何冲突两份内容都不丢
- 加密口令可自设（PBKDF2 派生密钥）；不设则用内置口令，开箱即用
- 本地定时备份、云端历史留底、回收站，多层兜底

## 常见问题

**清除浏览器数据会丢笔记吗？** 网页端数据在浏览器本地存储中，清数据会清空本地笔记——所以请开 WebDAV 同步，换设备/换浏览器填同一账号即可完整恢复。

**没有官方账号体系？** 对。你的 WebDAV 就是你的账号，枝记不收集任何数据。

**维护节奏？** 个人业余项目，按兴趣维护，issue 不保证及时回复。由于无服务器依赖，已发布版本会一直可用。

## 协议

[AGPL-3.0](LICENSE)。本项目由 AI 辅助开发。

© 2026 dalou · [Quicker 主页](https://getquicker.net/User/Actions/76824-dalou)
