// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// What a fresh bento/spaces file opens with.
//
// The brief slides set: the product demo, the launch asset and the feature
// tour in one — every claim it makes is proven by the feature making it. So
// the page that describes links CONTAINS a link, the page about sharing is
// reachable only through one, and the limits page says the awkward things out
// loud rather than letting them be discovered.

import { FORMAT, FORMAT_VERSION, defaultTheme, type SpacesDoc, type Block } from './model'

const b = (type: string, html = '', extra: Partial<Block> = {}): Block =>
  ({ id: `sd-${(seq++).toString(36)}`, type, html, ...extra })

let seq = 0

/** Deterministic ids: a generator must emit the same document twice. */
export function starterDoc(): SpacesDoc {
  seq = 0
  const P = {
    home: 'sd-home',
    links: 'sd-links',
    writing: 'sd-writing',
    limits: 'sd-limits',
    inbox: 'sd-inbox',
  }

  // the toggle is built first so its child can name its REAL id — a parent
  // pointing at an id that does not exist would render the child at top level
  const toggle = b('toggle', 'A toggle — click the triangle', { open: true })

  return {
    format: FORMAT,
    version: FORMAT_VERSION,
    docId: '', // minted at boot; a template mints a fresh one every open
    title: 'My space',
    home: P.home,
    theme: defaultTheme(),
    pages: [
      {
        id: P.home,
        title: 'Welcome',
        icon: 'compass',
        blocks: [
          b('p', 'This whole space — every page, the editor, the search — is <b>one HTML file</b>. No account, no server, nothing installed.'),
          b('h2', 'Try it'),
          b('todo', 'Type something on this line', { done: false }),
          b('todo', 'Press <code>⏎</code> to make a new block, <code>Tab</code> to indent it', { done: false }),
          b('todo', 'Press <code>/</code> on an empty line for headings, lists, quotes and code', { done: false }),
          b('todo', 'Press <code>⌘K</code> to search every page at once', { done: false }),
          b('p', 'Then press <code>⌘S</code>. The file on your disk now contains everything you just wrote.'),
          b('h2', 'What is here'),
          b('p', 'Three pages, and each one demonstrates the thing it describes:'),
          b('bullet', '<a href="#p/sd-links">Pages and links</a> — how a space holds more than one page'),
          b('bullet', '<a href="#p/sd-writing">Writing</a> — the blocks you can make'),
          b('bullet', '<a href="#p/sd-limits">Sharing &amp; limits</a> — what this file can and cannot do'),
          b('p', 'The sidebar holds the whole tree. Drag a page onto another to nest it.'),
        ],
      },
      {
        id: P.links,
        title: 'Pages and links',
        icon: 'link',
        blocks: [
          b('p', 'A space is a <b>tree of pages</b>, not a single scroll. New page: the ＋ in the sidebar, or <code>⌘⌥N</code>.'),
          b('h2', 'Linking'),
          b('p', 'Type <code>[[</code> anywhere to search your pages and drop a link in. If the page does not exist yet, the picker offers to make it.'),
          b('p', 'That link back to <a href="#p/sd-home">Welcome</a> was made exactly that way.'),
          b('h2', 'Backlinks'),
          b('p', 'Scroll to the bottom of any page and it tells you what links <i>to</i> it. Nothing to maintain — it is derived from the links themselves every time the page opens.'),
          b('p', 'This page links to <a href="#p/sd-writing">Writing</a>, so Writing lists this page underneath.'),
          b('h2', 'Why one file'),
          b('p', 'Links are page ids inside this document, so they resolve with the wifi off, from an email attachment, on a phone, and in ten years. A link between separate files could not do any of that.'),
        ],
      },
      {
        id: P.writing,
        title: 'Writing',
        icon: 'pen',
        blocks: [
          b('p', 'Markdown shortcuts convert as you type them.'),
          b('h2', 'Headings'),
          b('p', 'Type <code># </code>, <code>## </code> or <code>### </code> at the start of a line.'),
          b('h2', 'Lists'),
          b('bullet', '<code>- </code> makes a bullet'),
          b('bullet', 'and <code>Tab</code> nests it'),
          b('number', '<code>1. </code> makes a numbered list'),
          b('todo', '<code>[] </code> makes a checkbox', { done: false }),
          b('h2', 'Blocks that are not text'),
          b('quote', 'A quote — type <code>&gt; </code>.'),
          b('code', 'const space = oneFile\n// ```  makes a code block', { lang: 'js' }),
          toggle,
          b('p', 'Anything indented under a toggle folds away with it.', { parent: toggle.id }),
          b('divider'),
          b('p', 'Inline: <b>⌘B</b>, <i>⌘I</i>, <u>⌘U</u>.'),
        ],
      },
      {
        id: P.limits,
        title: 'Sharing & limits',
        icon: 'scale',
        blocks: [
          b('p', 'Worth knowing before you rely on this.'),
          b('h2', 'Sharing is per file'),
          b('p', 'Sending someone this file sends them <b>the whole space</b> — every page, including any you archived. There is no per-page permission, because there is no server to enforce one.'),
          b('h2', 'Saving'),
          b('p', 'On Chrome and Edge, <code>⌘S</code> writes back to the file you opened. Everywhere else — Safari, Firefox, and every browser on iOS — the browser gives a page no way to write to its own file, so each save downloads a <b>new copy</b>. That is a browser limitation, not a setting.'),
          b('h2', 'Two people, two files'),
          b('p', 'If two people edit their own copy at the same time, there is no merge. They are two files. Live collaboration is coming; until it does, this is the honest position.'),
          b('h2', 'Size'),
          b('p', 'Text is essentially free — hundreds of pages of prose stay a small file. Images are what make it big, because they travel inside it.'),
        ],
      },
      {
        id: P.inbox,
        title: 'Inbox',
        icon: 'inbox',
        blocks: [
          b('p', 'A page to throw things into before they are worth filing.'),
          b('p', ''),
        ],
      },
    ],
  }
}
