#!/usr/bin/env bash
# show-doc.sh — cmux 우측 프리뷰 pane 에 마크다운(또는 임의) 문서를 렌더링.
#
# 동작:
#   - workspace 별로 단일 프리뷰 pane 을 재사용 (UUID 를 상태파일에 저장).
#   - cmux open 이 .md 를 네이티브 마크다운 프리뷰 탭으로 렌더링.
#   - best-effort: cmux 가 없거나/실패해도 caller 본 작업을 막지 않음 (exit 0).
#
# 사용: show-doc.sh <path> [<path>...]
set -uo pipefail

notice() { printf 'doc-preview-pane: %s\n' "$*" >&2; }

UUID_RE='[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}'

# ── 가드 ────────────────────────────────────────────────────────────────
command -v cmux >/dev/null 2>&1 || { notice "cmux CLI 없음 — 프리뷰 생략."; exit 0; }
[ -n "${CMUX_WORKSPACE_ID:-}" ] || { notice "cmux workspace 밖 (CMUX_WORKSPACE_ID 미설정) — 프리뷰 생략."; exit 0; }
[ "$#" -gt 0 ] || { notice "사용법: show-doc.sh <path> [<path>...]"; exit 2; }

# ── 인자 → 존재하는 절대경로만 ───────────────────────────────────────────
paths=()
for p in "$@"; do
  [ -e "$p" ] || { notice "파일 없음: $p — 건너뜀"; continue; }
  case "$p" in
    /*) abs="$p" ;;
    *)  abs="$(cd "$(dirname "$p")" && pwd)/$(basename "$p")" ;;
  esac
  paths+=("$abs")
done
[ "${#paths[@]}" -gt 0 ] || { notice "표시할 기존 파일 없음."; exit 0; }

ws="$CMUX_WORKSPACE_ID"
state_dir="${XDG_STATE_HOME:-$HOME/.local/state}/cmux-doc-preview"
mkdir -p "$state_dir"
state_file="$state_dir/${ws}.pane"

# 현재 workspace 의 pane UUID 목록 (한 줄에 하나).
list_pane_uuids() {
  cmux list-panes --workspace "$ws" --id-format uuids 2>/dev/null | grep -oE "$UUID_RE"
}

# ── 프리뷰 pane 해석 (재사용 우선, 없으면 생성) ──────────────────────────
preview=""
stray_surface=""   # 갓 만든 pane 의 터미널 surface (open 후 정리용)
if [ -f "$state_file" ]; then
  saved="$(cat "$state_file" 2>/dev/null)"
  if [ -n "$saved" ] && list_pane_uuids | grep -qiF "$saved"; then
    preview="$saved"
  fi
fi

if [ -z "$preview" ]; then
  before="$(list_pane_uuids | sort)"
  if ! cmux new-pane --workspace "$ws" --direction right --focus false >/dev/null 2>&1; then
    notice "프리뷰 pane 생성 실패 — 생략."; exit 0
  fi
  # new-pane 등록까지 짧게 폴링 (sleep 없이 재조회).
  for _ in $(seq 1 40); do
    after="$(list_pane_uuids | sort)"
    preview="$(comm -13 <(printf '%s\n' "$before") <(printf '%s\n' "$after") | grep -oE "$UUID_RE" | head -1)"
    [ -n "$preview" ] && break
  done
  [ -n "$preview" ] || { notice "새 pane id 확인 실패 — 생략."; exit 0; }
  printf '%s\n' "$preview" > "$state_file"
  # new-pane 이 만든 빈 터미널 surface — open 후 닫아 문서만 남긴다.
  stray_surface="$(cmux list-pane-surfaces --pane "$preview" --id-format uuids 2>/dev/null | grep -oE "$UUID_RE" | head -1)"
fi

# ── 문서 열기 (포커스는 agent pane 유지) ─────────────────────────────────
if cmux open "${paths[@]}" --pane "$preview" --no-focus >/dev/null 2>&1; then
  # 생성 경로였다면 잔여 터미널 탭 정리 (best-effort).
  [ -n "$stray_surface" ] && cmux close-surface --surface "$stray_surface" >/dev/null 2>&1 || true
  printf 'doc-preview-pane: 우측 pane(%s)에 문서 %d개 표시\n' "$preview" "${#paths[@]}"
else
  notice "cmux open 실패 — pane 이 닫혔을 수 있음, 상태 초기화."
  rm -f "$state_file"
  exit 0
fi
