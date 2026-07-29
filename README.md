# claude-skillbelt

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
![Claude Code plugin](https://img.shields.io/badge/Claude_Code-plugin-d97757)
![cmux doc preview](https://img.shields.io/badge/cmux-doc_preview-3572A5)
![cmux browser pane](https://img.shields.io/badge/cmux-browser_pane-3572A5)

> Topics: `claude-code` · `claude-code-plugin` · `claude` · `cmux` · `ai-tools` · `developer-tools`

A small collection of **Claude Code skills** packaged as a plugin + marketplace.
Currently bundled skills: `doc-preview-pane`, `browser-pane`.

## Install

Inside Claude Code:

```
/plugin marketplace add https://github.com/gw-space/claude-skillbelt.git
/plugin install skillbelt@claude-skillbelt
```

> Or clone locally first: `/plugin marketplace add /path/to/claude-skillbelt`

After installing/updating, apply it in the current session with **`/reload-plugins`**, or
just **restart Claude Code**. (If a skill was already invoked once, its edited body is
re-read the next time that skill is called.)

## Skills

| # | Skill | One-liner |
|:-:|---|---|
| 1 | [`doc-preview-pane`](#1-doc-preview-pane) | Right after you write/update a design or plan markdown doc, render it natively in the cmux right-side preview pane. |
| 2 | [`browser-pane`](#2-browser-pane) | Open a URL / local dev server / dashboard in the cmux right-side browser pane (reuses one pane per workspace). |

<br><br>

---

# 1. doc-preview-pane 📄

> Render a **markdown doc natively in the cmux right-side preview pane**. No separate
> viewer (glow, etc.) needed — `cmux open` renders `.md` as a markdown preview tab.

| | |
|---|---|
| **When** | Right after writing / substantially updating a design or plan markdown doc, or on a "show it on the right" request |
| **Depends on** | `cmux` CLI |
| **Platform** | Only meaningful inside a cmux session — a silent no-op elsewhere |

### Triggers

- Right after **writing or substantially updating** an architecture/design/plan markdown doc.
- When the user says "show / render this doc on the right."
- Not for ordinary README edits, code comments, or one-or-two-line changes (noise).

### Invocation

```bash
bash "${CLAUDE_PLUGIN_ROOT}/skills/doc-preview-pane/scripts/show-doc.sh" <abs-path.md> [<more.md> ...]
```

### Behavior & guarantees

- **Single pane reuse** — the per-workspace preview pane UUID is stored at
  `~/.local/state/cmux-doc-preview/<workspace-id>.pane`. If alive it's reused (a new
  tab); if closed, a new split is created on the right → the screen never keeps splitting.
- **Focus preserved** — always opens in the dedicated right pane; never touches the working (agent) pane.
- **Multiple docs** — pass several at once to open as tabs in the same right pane; call again with the same path to refresh.
- **Best-effort** — if cmux is absent, you're outside a workspace, or pane creation/open
  fails, it exits `0` quietly. The doc is already saved, so the main work is unaffected.
- **Self-healing** — if the user closes the right pane, the failed `open` is detected, the
  state file is cleared, and the next call recreates it.

<br><br>

---

# 2. browser-pane 🌐

> Open a **URL in the cmux right-side browser pane** — local dev servers, dashboards, doc
> sites. Sibling of `doc-preview-pane`: that one renders a markdown *file*, this one opens a
> *URL* as a browser tab.

| | |
|---|---|
| **When** | Right after starting a local server, or on a "show this URL / localhost on the right" request |
| **Depends on** | `cmux` CLI (browser feature; auto-enabled via `cmux enable-browser`) |
| **Platform** | Only meaningful inside a cmux session — a silent no-op elsewhere |

### Triggers

- User says "open / show this URL (or `localhost:PORT`) on the right."
- Right after you launch a local dev / preview / dashboard server.

### Invocation

```bash
bash "${CLAUDE_PLUGIN_ROOT}/skills/browser-pane/scripts/open-url.sh" <url> [<url> ...]
```

`http://`/`https://` optional — a bare `localhost:8000` or `example.com` gets `http://` prepended. Multiple URLs open as tabs in the same pane.

### Behavior & guarantees

- **Single pane reuse** — the per-workspace browser pane UUID is stored at
  `~/.local/state/cmux-browser-pane/<workspace-id>.pane`. Reused if alive (a new tab),
  recreated on the right if closed → the screen never keeps splitting.
- **Focus preserved** — always opens in the dedicated right pane; never touches the working (agent) pane.
- **Best-effort** — if cmux is absent, you're outside a workspace, or pane creation/open
  fails, it exits `0` quietly; the main work is unaffected.
- **Self-healing** — if the user closes the right pane, the next call recreates it.

## License

[MIT](LICENSE) © Gunwoo Yoon
