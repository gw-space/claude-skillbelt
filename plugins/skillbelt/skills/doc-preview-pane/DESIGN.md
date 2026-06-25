# doc-preview-pane — Design

작성한 아키텍처/설계/플랜 마크다운을 **cmux 우측 프리뷰 pane** 에 렌더링해서 보여주는
개인 스킬. 2026-06-18.

## 동기

설계/플랜 문서를 쓰면 사용자가 별도 창을 열지 않고 바로 옆에서 렌더링된 결과를 보고
싶어 한다. cmux 는 `cmux open <file.md>` 로 마크다운을 **네이티브 프리뷰 탭**으로
렌더링하고 `--pane` 으로 대상 pane 을 지정할 수 있다 → 별도 뷰어(glow 등) 불필요.

## 구성

| 파일 | 책임 |
|---|---|
| `SKILL.md` | 트리거 설명 + 호출 방법 |
| `scripts/show-doc.sh` | pane 재사용/생성 + `cmux open` (전체 로직 캡슐화) |

## show-doc.sh 흐름

1. **가드** — `cmux` 없거나 `CMUX_WORKSPACE_ID` 없으면 `exit 0` (비차단).
2. **인자 정규화** — 존재하는 파일만 절대경로로.
3. **프리뷰 pane 해석**
   - 상태파일(`~/.local/state/cmux-doc-preview/<workspace>.pane`)의 UUID 가
     현재 workspace `list-panes` 에 있으면 → 재사용.
   - 없으면 `new-pane --direction right --focus false` → before/after diff 로
     새 pane UUID 확정 → 상태파일에 저장.
4. **열기** — `cmux open <paths> --pane <preview> --no-focus`.

## 보장

- **단일 pane 재사용** — 호출 반복해도 화면이 안 쪼개진다.
- **agent pane 안전** — 전용 우측 pane 에만 열고 작업 중 pane 엔 안 연다.
- **Best-effort** — 모든 cmux 실패는 조용히 `exit 0`, 본 작업 무영향.

## 설계 결정

- 위치: **개인 스킬**(`~/.claude/skills/`) — 모든 workspace 에서 동작, board 전용 아님.
- 포커스: **`--no-focus`** — 문서는 우측에 뜨되 입력 포커스는 agent pane 유지.
- 동작 방식: **스킬**(모델이 판단해 호출) — 훅 자동화는 채택 안 함.
