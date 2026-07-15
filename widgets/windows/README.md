# DS 서비스 상태 트레이 위젯

DS스토어·동아사이언스 닷컴·d라이브러리 3개 서비스의 상태를
윈도우 트레이에 얼굴 아이콘으로 상시 표시하는 위젯.

데이터는 **경량 모니터링**(공개 레포 [ds-light-monitor](https://github.com/dongascience-planning/ds-light-monitor),
30분 주기)의 `docs/data/history-light.json`을 raw URL로 5분마다 읽는다.
공개 데이터라 인증 불필요 — 누구에게나 배포 가능.

## 동작

- 아이콘 = **검정 박스 안에 꽉 찬 경광등**: 초록 돔(3서비스 모두 정상) / 주황 돔+빛살(느림·이미지 깨짐·이력 지연) / 빨강 돔+빛살(장애) / 회색 돔(데이터 없음)
  (빛살은 "경보가 울리는 중"이라는 의미. 얼굴 아이콘인 Claude 사용량 위젯과 실루엣으로 즉시 구분.
   배경 박스·크기는 RenderBeacon 오버로드로 조절 가능)
- 마우스 오버 = 요약 툴팁 ("DS 8.0s · 닷컴 1.8s · dl 1.4s")
- 왼쪽 클릭 = 상세 팝업: 서비스별 상태·응답시간·24시간 가동률 + 마지막 점검 시각 + 대시보드/새로고침 링크
- 오른쪽 클릭 = 새로고침 / 대시보드 열기 / 로그인 시 자동 시작 / 종료
- 서비스가 장애로 전환되거나 복구되는 순간 풍선 알림 (전이 시 1회)
- 마지막 점검이 90분 이상 지연되면 "점검 이력 지연" 경고 (경량 발사 누락 감지)
- 일시 조회 실패 시 마지막 상태를 유지한 채 오류 안내만 표시

## 빌드

의존성 없음. claude-usage-widget과 동일한 방식:

```
C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe /nologo /warnaserror /target:winexe /codepage:65001 /out:DsStatus.exe /r:System.dll /r:System.Core.dll /r:System.Drawing.dll /r:System.Windows.Forms.dll /r:System.Net.Http.dll /r:System.Web.Extensions.dll Program.cs
```

빌드 전 실행 중인 위젯 종료 필요. C# 5 문법만 사용 가능 (문자열 보간·`?.` 불가).

## 테스트

`tests\TestMain.cs` — 파싱·상태판정·가동률·안내문 27케이스. 코드 수정 후 반드시 실행:

```
csc.exe /nologo /target:exe /codepage:65001 /main:DsStatusWidget.TestMain /out:%TEMP%\DsTests.exe (동일 참조) Program.cs tests\TestMain.cs
```

## 이력

- 2026-07-14 최초 작성 — claude-usage-widget(사용량 위젯) 코드 재활용. 그 프로젝트의 3회 풀검수에서 확정된 패턴(fetching try/finally, exiting 플래그, 항목단위 파싱 방어, 오류 안내 동적 박스, 마지막 상태 유지) 그대로 적용
