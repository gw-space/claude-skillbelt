# codex-failover — Design

작업이 에러로 막히면 **무조건 Codex(gpt-5.5, xhigh, write)로 fallback** 해서
이어서 끝내고, 결과를 프로젝트 git 플로우로 머지하는 개인 스킬. 2026-06-23.

## 동기

API 에러(rate limit / 5xx / overloaded / terminal error), 분류기·보안 차단,
또는 서브에이전트·Workflow 실패로 작업이 중단되면 그 자리에서 멈추지 말고
Codex 런타임으로 넘겨 작업을 계속 완수한다. 멈춤·되묻기 없이 에러 즉시 전환.

## 구성

| 파일 | 책임 |
|---|---|
| `SKILL.md` | 트리거(에러 종류) + fallback 프로토콜(dispatch→검증→머지) |

## 두 레벨

- **메인 루프 사후 반응**: 서브에이전트/Workflow 실패 알림을 관찰하면 막힌 부분을
  Codex로 재수행 후 최종 결과에 봉합. (래퍼 없는 기존 워크플로용)
- **워크플로 실행 중 자동 교체**: `agentOrCodex()` 래퍼를 `agent()` 대신 호출 →
  실패(null) 시 같은 자리에서 `agentType:'codex:codex-rescue'`(gpt-5.5/xhigh)로
  재시도, 결과가 같은 pipeline/parallel 집계로 흘러 **최종 결과에 자동 병합**.
  스키마 단계는 codex stdout 을 lenient JSON 파싱(검증 보장 X → 병합 후 확인).

## 핵심 메커니즘

- **codex-rescue 래퍼는 `--model`/`--effort`/`--write`를 명시할 때만 붙인다**
  (agents/codex-rescue.md 규칙). 그래서 dispatch 프롬프트에 "model gpt-5.5
  (`--model gpt-5.5`), effort xhigh (`--effort xhigh`), `--write`"를 직접 적는다.
- codex CLI v0.136.0: `codex exec -m <model>`, `--effort <value>`, 또는
  `-c model_reasoning_effort=<value>`. 래퍼 경로는
  `codex-companion.mjs task --model … --effort … --write …`.
- **Codex 샌드박스 = Bash 전용**(SSH·browser·대화형 MCP 불가). 파일 편집은 Codex,
  sync/ACR build/ansible/headless 검증/MR 는 메인 Claude 루프가 수행 (역할 분담).

## 설계 결정

- 위치: **개인 스킬**(`~/.claude/skills/`) — 모든 workspace 에서 동작.
- 트리거: **에러·실행 차단** 관찰 시 무조건 발동 (되묻지 않음). 사용자 명시 요구.
- 모델: `gpt-5.5` 우선, 미인식 시 최신 `gpt-5.x-codex` 로 대체하고 명시.
- 종료 조건: Codex 도 실패하면 무한 루프 대신 사용자에게 컨텍스트 보고.
- Workflow 재시도: `{scriptPath, resumeFromRunId}` 로 캐시 재개 후, 그래도 막히는
  부분만 Codex fallback.
