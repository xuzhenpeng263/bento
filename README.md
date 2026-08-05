# WebDeck — 自包含的演示文稿编辑器

**WebDeck 是一个 PowerPoint 的替代方案，整个编辑器就在一个 HTML 文件里。**

一个 `.webdeck.html` 文件就是一份完整的演示文稿：幻灯片、演讲者备注、实时图表、嵌入媒体和交互元素全部包含在内。每个文件自带查看器、编辑器和演示器——在浏览器中双击即开，无需安装。

**10 秒体验**：打开 [xuzhenpeng263.github.io/webdeck](https://xuzhenpeng263.github.io/webdeck) 即可看到完整应用。

**GitHub 仓库**：[xuzhenpeng263/webdeck](https://github.com/xuzhenpeng263/webdeck)

---

## 功能特性

- **自包含**：一个 `.webdeck.html` 文件 = 文档 + 查看器 + 编辑器 + 演示器
- **变形过渡**：模型驱动的变形动画（位移/缩放/颜色），通过匹配元素 ID 在幻灯片之间实现无缝过渡
- **实时图表**：柱状图、折线图、饼图、散点图，支持动画过渡和双轴显示
- **表格**：可编辑表格，支持表头切换、斑马纹和列宽拖拽
- **演讲者视图**：独立的演讲者窗口，包含计时器、备注和幻灯片预览
- **密码加密**：AES-256-GCM 静态文档加密
- **实时协作**：端到端加密的实时编辑（可选功能），基于 CRDT 的字符级文本合并
- **AI 友好**：文档内容为纯 JSON，AI 代理可直接创作和编辑文稿
- **响应式界面**：适配桌面和移动端浏览器
- **PPTX 导出**：按需导出 PowerPoint 格式
- **8 种界面语言**：中文（简/繁）、英文、日文、西班牙文、法文、德文、意大利文

---

## 快速开始

### 打开已有文稿

直接双击任意 `.webdeck.html` 文件，即可在浏览器中打开完整编辑器。

### 新建文稿

1. 在浏览器中打开 `WebDeck.webdeck.html`
2. 点击 **新建文件** 创建空白文稿，或点击 **打开文件** 打开已有文稿
3. 开始编辑——文本、图形、图片、图表、表格

### 从源码构建

```bash
cd slides
npm install
npm run dev           # 开发服务器（localhost:5199）
npm run build:single  # 构建产物 → dist-single/WebDeck.webdeck.html
```

要求：Node.js 20+

---

## 架构

WebDeck 使用纯 TypeScript 构建为**单文件应用**，无需后端——`.webdeck.html` 文件本身就是应用。

- **文档模型**：基于 JSON 的格式（`src/model.ts`）——所有幻灯片内容、主题和元数据在一个结构中
- **自保存机制**：应用在启动时克隆自身，保存时将更新后的文档数据写回 HTML 文件（File System Access API + 下载降级）
- **动画引擎**：自研补间动画引擎（`src/anim.ts`），支持变形、入场动画、计数动画和运动路径
- **图表引擎**：自研 SVG 图表渲染器（`src/charts.ts`），兼容 ECharts 选项格式
- **协作系统**：基于 CRDT 的端到端加密同步（`src/sync/`），使用 Cloudflare Durable Object 盲中继
- **压缩外壳**：运行时 JS/CSS 经 deflate 压缩嵌入——浏览器在启动时解压

深入阅读：[docs/architecture.md](docs/architecture.md)

---

## 安全模型

- 协作密钥在客户端文档创建时生成，仅存在于文件中。拥有文件 = 拥有访问权限；"轮换密钥" = 撤销权限
- 中继服务器仅能看到密文、连接时间和房间密钥哈希，无法读取内容、名称或结构
- 更新检查获取静态清单，不发送任何用户或文档信息。签名 + 哈希 + 版本单调性在应用内验证
- 已知权衡：实时协作期间的撤销是快照级别的，可能还原协作者对同一属性的并发编辑；编辑以桌面端为主（手机端查看和演示良好）

---

## 技术栈

纯 TypeScript，无框架依赖。使用以下核心库（均 MIT 许可，已内嵌）：

| 库 | 用途 |
|------|------|
| [Reveal.js](https://revealjs.com) | 演示引擎 |
| [Moveable](https://github.com/daybrush/moveable) | 元素拖拽操作 |
| [Selecto](https://github.com/daybrush/selecto) | 框选工具 |
| [PPTXGenJS](https://github.com/gitbrent/PptxGenJS) | PPTX 导出 |
| [Temml](https://github.com/derilkillms/temml) | 数学公式渲染 |

---

## 与 AI 协作

文档是文件顶部的一个纯文本 JSON 块，任何能读写文件的 AI 助手都可以编辑你的文稿：

- **文件直接编辑**：Claude Code、Cursor、Aider 等可直接编辑 `#webdeck-doc` JSON 块
- **对话往返**：复制文档 JSON（保存 → 复制文档 JSON），让 AI 助手修改后粘贴回来
- **离线可用**：配合 Ollama、llama.cpp 或 LM Studio 使用本地开源模型，数据不离开本机

---

## 阅读更多

- [CLAUDE.md](CLAUDE.md) — 深度架构与开发指南
- [docs/architecture.md](docs/architecture.md) — 文件格式和运行时架构
- [docs/format.md](docs/format.md) — 文档模型规范
- [docs/collab-design.md](docs/collab-design.md) — CRDT 协作设计
- [docs/agents.md](docs/agents.md) — AI 代理指南
- [CHANGELOG.md](CHANGELOG.md) — 版本历史
- [CONTRIBUTING.md](CONTRIBUTING.md) — 贡献指南

---

## 开源许可

WebDeck 基于 [MIT License](LICENSE) 开源。© 2026 The WebDeck authors。

内嵌运行时组件（reveal.js、Moveable、Selecto）均为 MIT 许可；内嵌字体（Fraunces、Instrument Sans）为 SIL Open Font License；图库图片为公共领域。

---

## 致谢

本项目基于 **[Bento](https://github.com/nyblnet/bento)** 深度定制而来。Bento 是一个出色的自包含办公文档平台，由 The Bento authors 创建并维护。感谢原项目的所有贡献者，他们的开创性工作为 WebDeck 奠定了坚实的基础。
