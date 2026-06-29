# browser-pane — design notes

## 목적

cmux 우측에 **단일 브라우저 pane** 을 만들어 URL(로컬 dev 서버·대시보드·웹앱)을 옆에서
보여준다. `doc-preview-pane` 의 자매 스킬 — 그쪽은 마크다운 *파일* 을 네이티브 프리뷰로
렌더링하고, 이쪽은 *URL* 을 브라우저 탭으로 연다.

## 핵심 결정

- **`doc-preview-pane` 패턴 그대로 재사용.** workspace 별 단일 pane UUID 를 상태파일
  (`~/.local/state/cmux-browser-pane/<ws>.pane`)에 저장 → 호출할수록 화면이 쪼개지지 않음.
  생성은 `cmux new-pane --type browser --direction right --focus false`, 로드는
  `cmux open <url> --pane <uuid> --no-focus`.
- **pane id 확인은 before/after diff.** `new-pane` 의 출력 포맷에 의존하지 않고
  `list-panes --id-format uuids` 스냅샷 차집합으로 새 pane UUID 를 찾는다 (show-doc.sh 와 동일).
- **빈 브라우저 surface 정리.** 새 pane 의 초기 빈 탭(stray surface)은 URL 로드 후 닫아
  깔끔하게 URL 탭만 남긴다.
- **Best-effort & 비침습.** cmux 밖/실패는 전부 `exit 0`, agent pane 은 절대 안 건드림,
  포커스 유지. 자동 호출(서버 띄운 직후)에 안전.
- **URL 정규화.** scheme 없는 인자에 `http://` 를 붙여 `localhost:8000` 같은 입력도 허용.

## 왜 doc-preview-pane 과 합치지 않았나

트리거(파일 vs URL)·렌더링 경로(마크다운 프리뷰 vs 브라우저)·재사용 상태(별도 pane)가
달라 별 스킬이 깔끔하다. 상태 디렉터리도 분리(`cmux-doc-preview` vs `cmux-browser-pane`)해
문서 pane 과 브라우저 pane 이 서로를 덮지 않게 한다.
