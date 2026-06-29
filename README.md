# claude-skillbelt

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
![Claude Code plugin](https://img.shields.io/badge/Claude_Code-plugin-d97757)
![Codex failover](https://img.shields.io/badge/Codex-failover-10a37f)
![cmux doc preview](https://img.shields.io/badge/cmux-doc_preview-3572A5)
![cmux browser pane](https://img.shields.io/badge/cmux-browser_pane-3572A5)

> Topics: `claude-code` · `claude-code-plugin` · `claude` · `codex` · `cmux` · `ai-tools` · `developer-tools`

A small collection of **Claude Code skills** packaged as a plugin + marketplace.
Currently bundled skills: `codex-failover`, `doc-preview-pane`, `browser-pane`.

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
| 1 | [`codex-failover`](#1-codex-failover) | When a Claude task (including subagents/Workflows) is blocked by an error, fall back to Codex (gpt-5.5/xhigh) to finish the same work — its result flows into the workflow's aggregation so the orchestrating main agent can assemble the final result. |
| 2 | [`doc-preview-pane`](#2-doc-preview-pane) | Right after you write/update a design or plan markdown doc, render it natively in the cmux right-side preview pane. |
| 3 | [`browser-pane`](#3-browser-pane) | Open a URL / local dev server / dashboard in the cmux right-side browser pane (reuses one pane per workspace). |

<br><br>

---

# 1. codex-failover 🔁

> When a Claude agent/subagent/Workflow is **blocked by an error, fall back to Codex
> immediately**, finish the same work, and let that result flow into the workflow's
> aggregation so the **orchestrating main Claude can assemble a clean final result**.

| | |
|---|---|
| **When** | A task stalls on rate limit / 5xx / classifier or safety block / refusal / tool or Workflow failure |
| **Depends on** | codex CLI (logged in) · `openai-codex` plugin · model `gpt-5.5` |
| **Platform** | Any environment (Codex edits files in a Bash sandbox) |

### Usage (how to ask for it)

Work as usual, but run a multi-agent / Workflow pass with **ultracode** and
`codex-failover` kicks in automatically inside it. For example:

```
Review this project using ultracode and the codex-failover skill
```

```
Review this PR with ultracode, and for any agent that gets blocked, fall back to Codex to finish it
```

With no extra setup, a blocked agent is swapped out for Codex in place via the
`agentOrCodex()` wrapper and its result is folded into the same aggregation. (You don't
have to author a workflow yourself — writing the intent like "ultracode … codex
fallback …" lets Claude build the workflow with the wrapper.)

### Triggers (no error-type distinction → straight to Codex)

- rate limit (`Server is temporarily limiting requests` / 429 / 529),
- HTTP 5xx / overloaded / timeout,
- classifier / cybersecurity / safety block or refusal,
- terminal model/API error,
- tool / subagent / Workflow failure (`agent()` returns null, Bash/tool error, etc.).

> Claude and Codex are different providers, so a Claude rate limit does not throttle the Codex fallback.

### Behavior

1. **Capture handoff context** — goal/acceptance criteria, what was done and where
   (branch, files), the original task context, and (in a workflow) done vs. remaining units.
2. **Dispatch `codex:codex-rescue`** — `--model gpt-5.5 --effort xhigh --write`.
   Use `--background` for long, multi-step work; `--resume-last` to continue prior Codex work.
3. **Split of roles** — Codex runs in a Bash sandbox and does the actual work (file
   edits); cross-system steps (SSH/deploy/cloud builds) are left to the main agent.
4. **Aggregate the result** — Codex returns output in the shape the failed agent would
   have produced (matching any requested schema), so it folds into the **same
   pipeline/parallel aggregation** and the workflow's main Claude assembles it like any
   other agent's output. (Here "merge" means folding into the workflow output — NOT a
   git merge. The skill never commits/PRs/pushes.)
5. If Codex also fails, stop — no infinite loop — and surface the full context to the user.

### In-workflow fallback — `agentOrCodex()`

A plain `agent()` that fails leaves a `null` and the Workflow proceeds with that gap.
To **swap a failed agent for Codex in place and stream the result into the same
aggregation**, call the `agentOrCodex()` wrapper (in the skill body) instead of
`agent()` → Codex output lands in the `pipeline()`/`parallel()` result array and is
auto-merged at the synthesis stage.

> ⚠️ **Workflow scripts are PLAIN JAVASCRIPT** — TS type annotations/interfaces/generics
> fail to parse and the whole workflow is rejected. Paste the wrapper verbatim and "don't type it."

### Prerequisites (no-op without these)

1. **codex CLI installed + logged in** — check with `codex login status`. (ChatGPT account or API)
2. **openai-codex plugin installed** — provides the `codex:codex-rescue` agent.
3. **Model** — use `gpt-5.5` (ChatGPT-account Codex). (`gpt-5.5-codex` is not supported on ChatGPT accounts.)

### Does a cybersecurity block auto-fall-back while coding?

| Coding situation | On a cyber block |
|---|---|
| **Workflow/subagent is coding** (delegated) | ✅ **Automatic** — the `agentOrCodex` wrapper swaps in Codex in place |
| **A delegated tool/subagent fails** (inline coding) | ✅ I observe the failure → immediately go to Codex (skill protocol, effectively automatic) |
| **My own reply is blocked while generating code directly** | ⚠️ Not automatic that turn — the block ends my turn; I fall back to Codex on the next turn |

<br><br>

---

# 2. doc-preview-pane 📄

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

# 3. browser-pane 🌐

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
