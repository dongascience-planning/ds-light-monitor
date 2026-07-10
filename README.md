# 동아사이언스 경량 모니터링

동아사이언스 공개 서비스 3곳의 메인 페이지 상태를 매시간 점검합니다.
로그인·결제 등 계정 관련 점검은 하지 않으며, 공개 페이지 접속 확인만 수행합니다.

| 서비스 | 점검 URL |
|---|---|
| DS스토어 | https://dsstore.dongascience.com/main |
| 동아사이언스 닷컴 | https://www.dongascience.com/ko |
| d라이브러리 | https://dl.dongascience.com |

## 동작 방식

- 크론이 시간당 6회(:07 :17 :27 :37 :47 :57) 발사되고, 사전 체크의 dedup 가드(최근 25분 내 이력 존재 시 스킵)가 실제 점검을 30분당 1회로 제한합니다. 점검 슬롯당 본 트리거 1개 + 예비 2개 — GitHub Actions 크론 트리거 누락에 대비한 중복 트리거 구조입니다.
- 요일·공휴일 구분 없이 24시간, 30분 간격으로 점검합니다 (일 48회).
- 점검 항목: 페이지 로드 + 콘텐츠 링크 노출 + 이미지 로딩 + 응답 속도 (Playwright)
- 이상·느림·이미지 깨짐 감지 시에만 잔디(Jandi) 알림을 발송합니다.
- 결과는 `docs/data/history-light.json`에 최근 24시간 보관되며, 별도 대시보드가 이 파일을 조회합니다.

## Secrets

| Secret | 설명 |
|---|---|
| `JANDI_WEBHOOK_URL` | 잔디 Incoming Webhook URL (미설정 시 알림 없이 이력만 기록) |

## 수동 실행

Actions 탭 → 경량 모니터링 → **Run workflow**
