---
name: browser-pane
description: Open a URL (web page, localhost dev server, dashboard) in the cmux right-side browser pane. Use whenever the user asks to open/show/preview a URL or a local server (e.g. "이 사이트 오른쪽에 띄워줘", "localhost:3000 보여줘", a dev server or wiki you just started). Reuses a single browser pane per workspace. Only meaningful inside a cmux session; a no-op elsewhere.
---

# browser-pane

cmux 우측에 단일 브라우저 pane 을 만들어(이미 있으면 재사용) 주어진 URL 을 연다.
로컬 dev 서버·대시보드·문서 사이트 등을 작업 흐름을 끊지 않고 옆에서 볼 때 쓴다.
(마크다운 *파일* 을 렌더링해 보여주려면 `doc-preview-pane` 을 쓴다 — 이 스킬은 URL 용.)

## When to use

- 사용자가 "이 URL/사이트/서버 오른쪽에 띄워줘 / 보여줘" 라고 할 때.
- 로컬 dev 서버나 미리보기 서버를 띄운 **직후** — 바로 옆 pane 에서 확인하게 한다.

## How to use

URL 하나 이상을 헬퍼 스크립트에 넘긴다:

```bash
bash "${CLAUDE_PLUGIN_ROOT}/skills/browser-pane/scripts/open-url.sh" <url> [<url> ...]
```

예:

```bash
# 로컬 서버
bash "${CLAUDE_PLUGIN_ROOT}/skills/browser-pane/scripts/open-url.sh" http://127.0.0.1:8000
# scheme 생략 가능 (http:// 자동)
bash "${CLAUDE_PLUGIN_ROOT}/skills/browser-pane/scripts/open-url.sh" localhost:3000
# 여러 개 → 같은 pane 에 탭으로
bash "${CLAUDE_PLUGIN_ROOT}/skills/browser-pane/scripts/open-url.sh" localhost:3000 https://example.com
```

- scheme 없는 인자에는 `http://` 가 자동으로 붙는다.
- 포커스는 현재 (agent) pane 에 유지된다 — 입력 흐름이 끊기지 않는다.

## Behavior & guarantees

- **단일 pane 재사용:** workspace 별로 브라우저 pane UUID 를 `~/.local/state/cmux-browser-pane/<workspace-id>.pane` 에 저장. 다음 호출 때 살아있으면 재사용(탭 추가), 닫혔으면 새로 우측 split. → 호출할수록 화면이 쪼개지지 않음.
- **Best-effort:** cmux 가 없거나(다른 터미널), workspace 밖이거나, pane 생성/open 실패해도 `exit 0` 으로 조용히 빠진다. 본 작업에는 영향 없음.
- **agent pane 안전:** 항상 전용 우측 pane 에만 열고, 현재 작업 중인 pane 에는 절대 열지 않는다.
- 브라우저 기능이 꺼져 있으면 `cmux enable-browser` 로 먼저 켠다.

## Notes

- 우측 pane 을 사용자가 닫았다면 다음 호출 때 자동으로 다시 만든다.
- 같은 pane 에 여러 번 열면 탭이 쌓인다 — 필요 없는 탭은 사용자가 닫으면 된다.
