#!/usr/bin/env bash
# open-url.sh — cmux 우측 브라우저 pane 에 URL 을 연다 (workspace 별 단일 pane 재사용).
#
# 동작:
#   - workspace 별로 단일 브라우저 pane 을 재사용 (UUID 를 상태파일에 저장).
#   - cmux open 이 URL 을 브라우저 탭으로 로드.
#   - best-effort: cmux 가 없거나/실패해도 caller 본 작업을 막지 않음 (exit 0).
#
# 사용: open-url.sh <url> [<url>...]
#   scheme 없는 인자(localhost:8000, example.com)는 http:// 를 자동으로 붙인다.
set -uo pipefail

notice() { printf 'browser-pane: %s\n' "$*" >&2; }

UUID_RE='[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}'

# ── 가드 ────────────────────────────────────────────────────────────────
command -v cmux >/dev/null 2>&1 || { notice "cmux CLI 없음 — 생략."; exit 0; }
[ -n "${CMUX_WORKSPACE_ID:-}" ] || { notice "cmux workspace 밖 (CMUX_WORKSPACE_ID 미설정) — 생략."; exit 0; }
[ "$#" -gt 0 ] || { notice "사용법: open-url.sh <url> [<url>...]"; exit 2; }

# ── 인자 → URL 정규화 ────────────────────────────────────────────────────
urls=()
for u in "$@"; do
  case "$u" in
    http://*|https://*|file://*) urls+=("$u") ;;
    *)                           urls+=("http://$u") ;;
  esac
done

ws="$CMUX_WORKSPACE_ID"
state_dir="${XDG_STATE_HOME:-$HOME/.local/state}/cmux-browser-pane"
mkdir -p "$state_dir"
state_file="$state_dir/${ws}.pane"

list_pane_uuids() {
  cmux list-panes --workspace "$ws" --id-format uuids 2>/dev/null | grep -oE "$UUID_RE"
}

cmux enable-browser >/dev/null 2>&1 || true   # 브라우저 기능 보장 (best-effort)

# ── 브라우저 pane 해석 (재사용 우선, 없으면 생성) ────────────────────────
preview=""
stray_surface=""   # 갓 만든 pane 의 빈 브라우저 surface (open 후 정리용)
if [ -f "$state_file" ]; then
  saved="$(cat "$state_file" 2>/dev/null)"
  if [ -n "$saved" ] && list_pane_uuids | grep -qiF "$saved"; then
    preview="$saved"
  fi
fi

if [ -z "$preview" ]; then
  before="$(list_pane_uuids | sort)"
  if ! cmux new-pane --type browser --workspace "$ws" --direction right --focus false >/dev/null 2>&1; then
    notice "브라우저 pane 생성 실패 — 생략."; exit 0
  fi
  for _ in $(seq 1 40); do
    after="$(list_pane_uuids | sort)"
    preview="$(comm -13 <(printf '%s\n' "$before") <(printf '%s\n' "$after") | grep -oE "$UUID_RE" | head -1)"
    [ -n "$preview" ] && break
  done
  [ -n "$preview" ] || { notice "새 pane id 확인 실패 — 생략."; exit 0; }
  printf '%s\n' "$preview" > "$state_file"
  stray_surface="$(cmux list-pane-surfaces --pane "$preview" --id-format uuids 2>/dev/null | grep -oE "$UUID_RE" | head -1)"
fi

# ── URL 열기 (포커스는 agent pane 유지) ──────────────────────────────────
if cmux open "${urls[@]}" --pane "$preview" --no-focus >/dev/null 2>&1; then
  [ -n "$stray_surface" ] && cmux close-surface --surface "$stray_surface" >/dev/null 2>&1 || true
  printf 'browser-pane: 우측 pane(%s)에 URL %d개 열기\n' "$preview" "${#urls[@]}"
else
  notice "cmux open 실패 — pane 이 닫혔을 수 있음, 상태 초기화."
  rm -f "$state_file"
  exit 0
fi
