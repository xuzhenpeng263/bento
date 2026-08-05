# WebDeck — the self-contained presentation editor

**WebDeck is a PowerPoint alternative in a single HTML file.** Each deck carries its own viewer, editor, and presenter — open it in any browser, no install required.

A WebDeck file is a complete document: slides, speaker notes, live charts, embedded media, and interactive elements all in one `.webdeck.html` file.

**Try it online**: [xuzhenpeng263.github.io/webdeck](https://xuzhenpeng263.github.io/webdeck)

**GitHub**: [xuzhenpeng263/webdeck](https://github.com/xuzhenpeng263/webdeck)

---

## Features

- **Self-contained**: one `.webdeck.html` file = document + viewer + editor + presenter
- **Morph transitions**: model-driven morph (translate/scale/color) between slides with matching element IDs — PowerPoint-quality transitions without PowerPoint
- **Live charts**: bar, line, pie, scatter with animated transitions and dual-axis support
- **Tables**: editable tables with header toggles, zebra striping, and column resizing
- **Speaker view**: separate presenter window with timer, notes, and slide previews
- **Password encryption**: AES-256-GCM encrypted documents at rest
- **Live collaboration**: E2EE real-time editing with a blind relay (optional)
- **AI-friendly**: round-trip the document JSON — AI agents author and edit decks
- **Responsive UI**: works on desktop and mobile browsers
- **PPTX export**: export to PowerPoint format when needed

---

## Quick Start

### Open an existing deck

Just double-click any `.webdeck.html` file — it opens in your browser with the full editor.

### Create a new deck

1. Open `WebDeck.webdeck.html` in your browser
2. Click **New File** to start fresh, or **Open File** to work on an existing deck
3. Start editing — text, shapes, images, charts, tables

### Build from source

```bash
cd slides
npm install
npm run dev        # development server at localhost:5199
npm run build:single  # produces dist-single/WebDeck.webdeck.html
```

Requirements: Node.js 20+

---

## Architecture

WebDeck is built as a **single-file app** using vanilla TypeScript. There is no backend — the `.webdeck.html` file IS the application.

- **Document model**: JSON-based format (`src/model.ts`) — all slide content, theme, and metadata in one structure
- **Self-save trick**: the app clones itself at boot, then rewrites the HTML file with updated document data on save
- **Animation engine**: in-house tween engine (`src/anim.ts`) with morph, entrance stagger, count-up, and motion paths
- **Charts engine**: custom SVG chart renderer (`src/charts.ts`) interpreting ECharts-compatible options
- **Collaboration**: CRDT-based E2EE sync (`src/sync/`) with a Cloudflare Durable Object relay
- **Compressed shell**: runtime JS/CSS deflated into the shell; browser decompresses on boot

---

## Tech Stack

Vanilla TypeScript — no framework. Key libraries (all MIT licensed, bundled):

| Library | Purpose |
|----------|---------|
| [Reveal.js](https://revealjs.com) | Presentation engine |
| [Moveable](https://github.com/daybrush/moveable) | Element manipulation handles |
| [Selecto](https://github.com/daybrush/selecto) | Selection/marquee tool |
| [PPTXGenJS](https://github.com/gitbrent/PptxGenJS) | PPTX export |
| [Temml](https://github.com/derilkillms/temml) | Math rendering |

---

## License

WebDeck is open source under the [MIT License](LICENSE). © 2026 The WebDeck authors.

---

## Acknowledgments

This project is deeply based on **[Bento](https://github.com/nyblnet/bento)**, the brilliant self-contained office document platform created and maintained by The Bento authors. We are grateful to all contributors of the original Bento project — their pioneering work laid the foundation upon which WebDeck is built.

Built with reveal.js, Moveable, Selecto, and PPTXGenJS — all MIT licensed.
