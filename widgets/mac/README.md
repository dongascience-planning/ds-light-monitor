# ds-status (macOS)

DS스토어 · 동아사이언스 닷컴 · d라이브러리 3개 서비스의 상태를 macOS 메뉴바에 **경광등 아이콘**으로 상시 표시하는 SwiftBar 위젯.

데이터는 경량 모니터링([ds-light-monitor](https://github.com/dongascience-planning/ds-light-monitor), 30분 주기)의 공개 `history-light.json`을 5분마다 읽습니다. 인증 불필요.

## 아이콘

- 🟢 초록 돔 — 3서비스 모두 정상
- 🟠 주황 돔 + 빛살 — 주의(느림·이미지 깨짐·점검 이력 지연)
- 🔴 빨강 돔 + 빛살 — 장애
- ⚪ 회색 돔 — 데이터 없음

클릭하면 서비스별 상태·응답시간·24시간 가동률 + 마지막 점검 시각 + 대시보드/새로고침이 보입니다. 서비스가 장애/복구로 바뀌는 순간 알림도 뜹니다.

## 설치 (맥 전용)

압축을 푼 뒤 폴더에서:

```bash
./install.sh
```

bun·SwiftBar가 없으면 자동으로 설치합니다. 완료되면 메뉴바 오른쪽에 경광등이 뜹니다.

## 요구사항

- macOS
- (자동 설치됨) [bun](https://bun.sh), [SwiftBar](https://github.com/swiftbar/SwiftBar)

> Windows 버전은 별도(트레이 위젯)로 존재합니다. 이건 macOS(SwiftBar) 포팅본입니다.
