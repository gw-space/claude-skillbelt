# claude-skillbelt

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
![Claude Code plugin](https://img.shields.io/badge/Claude_Code-plugin-d97757)
![cmux doc preview](https://img.shields.io/badge/cmux-doc_preview-3572A5)
![cmux browser pane](https://img.shields.io/badge/cmux-browser_pane-3572A5)
![Teams read + send](https://img.shields.io/badge/Teams-read_%2B_send-5059C9)

> Topics: `claude-code` · `claude-code-plugin` · `claude` · `cmux` · `microsoft-teams` · `ai-tools` · `developer-tools`

A small collection of **Claude Code skills** packaged as a plugin + marketplace.
Currently bundled skills: `doc-preview-pane`, `browser-pane`, `teams`.

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
| 3 | [`teams`](#3-teams) | Read your Microsoft Teams chats and send messages from Claude Code — no Graph API, no admin consent. Needs a one-time setup. |

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

<br><br>

---

# 3. teams 💬

> **Read your Microsoft Teams chats and send messages — from Claude Code.**
> Ask "what did I miss in the last 3 days?" or "send Jane the summary" and it just works.

| | |
|---|---|
| **When** | Catching up on missed chats, extracting decisions/action items, tracking a topic, sending a message or reply |
| **Depends on** | Node.js 18+, Google Chrome, npm (setup installs `playwright-core`) |
| **Platform** | macOS / Linux / Windows (Chrome-driven; paths below assume macOS/Linux) |
| **Account** | A work/school Microsoft 365 account you can already sign into on Teams **web** |

### Why this exists

The obvious route — Microsoft Graph (`Chat.Read`) — is blocked in most corporate tenants:
they disable **user consent**, so every app hits *"admin approval required"*, and
registering your own Entra app does not help (consent policy applies regardless of who
owns the app). Work/school accounts also have **no self-service Teams export**.

So this skill takes the other road: it drives a real Chrome with a dedicated profile,
reuses the **token from your already-signed-in Teams web session**, and calls the same
chat-service endpoints the Teams web app itself uses. No app registration, no admin
consent.

> [!IMPORTANT]
> This deliberately routes around your tenant's app-consent gate. If your organization
> blocks third-party app access on purpose, using this may violate its policy. That is
> your call to make — check before you roll it out to a team.

### First-time setup

Two commands. The second one **you must run yourself** — MFA sign-in is interactive, so
Claude cannot do it for you.

```bash
TX="${CLAUDE_PLUGIN_ROOT}/skills/teams/scripts/teams-export.mjs"

node "$TX" setup    # creates ~/.teams-export, installs playwright-core, checks Chrome
node "$TX" login    # opens a Chrome window — sign in with your work account
```

On a sovereign cloud (GCC High / DoD), export `TEAMS_EXPORT_URL=https://teams.microsoft.us/`
first — sign-in and every later run must start on your own cloud's host. Put it in your
shell profile so unattended runs pick it up too.

`login` prints a `✅` confirmation once the session is saved. From then on every run is
headless and unattended. Sessions last days to weeks depending on tenant policy; when it
expires, run `login` again.

Then just talk to Claude:

```
"Find how the A issue was resolved in Teams last week"
"What did I miss over the 3 days I was away?"
"Send Enn a note asking for a reply"
```

Claude refreshes the corpus when it's stale, searches narrowly, and answers with quotes.

### Commands

Run as `node "$TX" <command>`. Claude drives these for you; they're here for reference.

| Command | What it does |
|---|---|
| `setup` | Create the data dir, install `playwright-core`, verify Chrome |
| `login` | One-time interactive sign-in (opens a window) |
| `list` | List your conversations |
| `export --all` | Collect everything. **Incremental** after the first run |
| `export <n\|id>` | Collect one conversation |
| `recent --days 3` | Recent messages grouped by room — offline, instant |
| `find "kw"` | Search the corpus. `--room` `--from` `--since` `--until` `--context N` |
| `stats` | Corpus size, date range, last-collection time |
| `send <room> "msg" --yes` | Send a message. Without `--yes` it only previews |
| `wipe` | Delete the saved login session |

### How it works

- **Conversation list** comes from Teams' own local IndexedDB (`Teams:conversation-manager`).
  The chat service's `/v1/users/ME/conversations` rejects a plain IC3 bearer with `401`.
- **Messages** page through `{chatServiceUrl}/v1/users/ME/conversations/{id}/messages`.
- **Incremental collection** — `state.json` records the newest message per room. Rooms with
  nothing new are skipped without a single network call; the rest fetch only the delta and
  merge (deduped by message id). Only the first run is slow.
- **Sending** POSTs to the same conversation resource, with the display name resolved from
  your MSAL cache so the author isn't blank.
- **No DOM scraping**, so Teams UI changes and virtualized scrolling don't break it.

### Data & privacy

- Everything is written to `~/.teams-export/` — code lives in the plugin, data does not, so
  plugin updates never wipe your session or corpus.
- Every outbound request goes to a Microsoft host (`authsvc`, `*.chatsvc`,
  `graph.microsoft.com`). Nothing is uploaded anywhere else.
- `~/.teams-export/profile` holds a **live authenticated Chrome profile** (mode `700`).
  Treat it like a credential; `node "$TX" wipe` removes it.
- `out/*.json` contains your chat history in plaintext. It sits on your disk under your
  home directory — back it up, or don't, accordingly.

### Caveats

- **Sending is irreversible.** Recipients are notified even if you delete the message
  afterwards. Room matching is a case-insensitive substring on the room label and picks the
  most recent match, so an ambiguous name can hit the wrong room — Claude previews first
  when the match is uncertain.
- **Permissions** — Claude Code's auto-mode classifier may block the command
  (`defaultMode: bypassPermissions` alone does not get past it). Approve the prompt, or add
  to `permissions.allow` in `~/.claude/settings.json`:
  `Bash(node <plugin-path>/skills/teams/scripts/teams-export.mjs:*)`
- **Headless sync** — if `list` comes back empty, run with `--headed` once so Teams can
  finish syncing its local store.

### Credits

MSAL cache decryption and the chat-service call shapes were derived from
[gediz/teams-web-chat-exporter](https://github.com/gediz/teams-web-chat-exporter) (MIT).

## License

[MIT](LICENSE) © Gunwoo Yoon
