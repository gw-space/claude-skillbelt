---
name: doc-preview-pane
description: Render a markdown document in the cmux right-side preview pane. Use right after you write or substantially update an architecture, design, or implementation-plan markdown doc (e.g. docs/superpowers/specs/*, docs/superpowers/plans/*, ARCHITECTURE.md, *-design.md, *-plan.md), or whenever the user asks to view/show/render a doc in the side pane. Only meaningful inside a cmux session; it is a no-op elsewhere.
---

# doc-preview-pane

cmux 우측에 단일 프리뷰 pane 을 만들어(이미 있으면 재사용) 마크다운 문서를 네이티브
렌더링으로 보여준다. `cmux open` 이 `.md` 를 마크다운 프리뷰 탭으로 렌더링하므로 별도
뷰어 불필요.

## When to use

- 아키텍처/설계/플랜 성격의 마크다운을 **작성하거나 크게 갱신한 직후** — 사용자가 바로
  옆에서 렌더링된 문서를 볼 수 있게 한다.
- 사용자가 "이 문서 오른쪽에 띄워줘 / 보여줘" 라고 요청할 때.

평범한 README 편집, 코드 주석, 한두 줄 수정 등에는 쓰지 않는다 (노이즈).

## How to use

작성한 문서의 **절대경로**로 헬퍼 스크립트를 호출한다:

```bash
bash "${CLAUDE_PLUGIN_ROOT}/skills/doc-preview-pane/scripts/show-doc.sh" <abs-path-to.md> [<more.md> ...]
```

- 여러 문서를 한 번에 넘기면 같은 우측 pane 에 탭으로 열린다.
- 포커스는 현재 (agent) pane 에 유지된다 — 작업 흐름이 끊기지 않는다.

## Behavior & guarantees

- **단일 pane 재사용:** workspace 별로 프리뷰 pane UUID 를 `~/.local/state/cmux-doc-preview/<workspace-id>.pane` 에 저장. 다음 호출 때 그 pane 이 살아있으면 재사용(탭 추가), 닫혔으면 새로 split. → 호출할수록 화면이 쪼개지지 않음.
- **Best-effort:** cmux 가 없거나(다른 터미널), workspace 밖이거나, pane 생성/open 이 실패해도 스크립트는 `exit 0` 으로 조용히 빠진다. 문서는 이미 저장돼 있으니 본 작업에는 영향 없음.
- **agent pane 안전:** 항상 전용으로 만든 우측 pane 에만 열고, 현재 작업 중인 pane 에는 절대 열지 않는다.

## Notes

- 프리뷰 내용이 갱신되면(문서를 다시 쓰면) 같은 경로로 한 번 더 호출하면 된다.
- 우측 pane 을 사용자가 닫았다면 다음 호출 때 자동으로 다시 만든다.
