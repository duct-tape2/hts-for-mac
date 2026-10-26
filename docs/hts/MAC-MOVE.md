# 다른 Mac에서 실행하기

소스는 설치 위치에 독립적으로 실행된다. 실행기는 자신의 파일 위치에서 프로젝트 루트를 찾는다. 기존 Mac의 `.venv`, `node_modules`, 빌드 결과를 복사하지 않고 새 Mac에서 고정 의존성을 다시 설치한다.

## 설치와 첫 실행

필요 도구는 Git, Node.js 22.13 이상인 22.x 또는 24.x/26 이상, npm, uv다. 새 Mac에서 먼저 아래 명령이 모두 동작하는지 확인한다. 설치 방법은 각 도구의 공식 배포 경로를 사용하며, 프로젝트 스크립트가 관리자 권한으로 도구를 설치하지는 않는다.

```bash
git --version
uv --version
node --version
npm --version
```

uv가 잠금 파일에 맞는 Python 3.13 환경을 준비한다. 기존 `.venv`, `node_modules`, 빌드 결과 또는 내려받은 SDK 소스를 복사하지 않는다. 공식 SDK 런타임은 `backend/uv.lock`에 고정된 공개 PyPI `kwcli` 패키지로 설치된다. Apple Silicon과 Intel의 실제 다른 기기 실행 검증은 아직 하지 않았다.

```bash
git clone https://github.com/duct-tape2/hts-for-mac.git
cd hts-for-mac
./scripts/setup.sh
npm --prefix frontend run build
python3 scripts/run_local.py --environment real
```

새 설치는 `13종 · 순위` 배치를 기본으로 엽니다. 개인적으로 바꾼 배치·관심종목까지 옮기려면 아래 내보내기/가져오기를 사용합니다.

[앱 열기](http://127.0.0.1:3010) → `API 연결 설정`에서 그 Mac의 키체인에 App Key·App Secret·등록 만료일을 저장한다. 등록 만료일은 미리 채워지지 않으므로 키움 포털에 표시된 본인의 날짜를 입력한다. 안내는 입력일의7일 전에 시작하며 접속 토큰의 자동 갱신과 구분한다. 이후 실행에는 키 재입력이 필요하지 않다. 허용 IP가 달라지면 [키움 API 관리](https://openapi.kiwoom.com/mgmt/VOpenApiRegView)에서 IP를 등록한다. 토큰·키체인 항목을 GitHub로 옮기지 않는다.

새 Mac의 키체인 저장/교체를 먼저 검사하려면 `backend/.venv/bin/python scripts/verify_keychain.py`를 실행한다. 실제 키나 네트워크를 사용하지 않고 고유한 시험 항목을 만든 뒤 제거한다. 의존성 업데이트 후에도 이 검사를 사용한다.

기본 포트는 화면3010/API8010이며 두 서버 모두 루프백으로 실행한다. 사용 중인 포트의 다른 프로세스를 강제 종료하지 않는다. 모의 서버는 `--environment demo`, 합성 테스트 화면은 `--environment fixture`로 명시한다.

## 데이터는 소스와 별개

| 저장 대상 | 위치 | 이전 방법 |
|---|---|---|
| 관심종목 그룹/항목 | `data/watchlist-v2.json` 또는 `READONLY_DATA_DIR` | 작업공간 메뉴 → 내보내기/가져오기. 기존 그룹에 중복 없이 병합 |
| 작업공간·이름·연동·고정·패널 설정 | 같은 브라우저/주소의 `kiwoom-hts-workstation-v2` | 작업공간 메뉴 → 내보내기/가져오기. 배치별 저장본 포함 |
| 알림·최근 선택 | `kiwoom-readonly-market-alerts-v1`, `kiwoom-readonly-recent-v1` | 브라우저 저장 데이터. 소스 clone만으로 이전되지 않음 |
| 분석 메모·차트 도구 | `hts-note:*`, `kiwoom-hts-chart-tools-v1` | 상단의 `개인 분석 백업`에서 JSON으로 내보낸 뒤 새 Mac에서 검증·복원. 알림·키·시세는 포함하지 않음 |
| API 키 | 기기별 macOS Keychain | 새 Mac의 설정 화면에서 한 번 직접 등록 |

현재 Mac에서 `작업공간 ▾ → 내보내기`로 저장한 `kiwoom-hts-workspace.json`을 새 Mac의 같은 메뉴에서 가져온다. 4개 작업공간·배치·표시 설정·관심종목만 포함하며, API 키·토큰·계좌·시세·메모·알림은 포함하지 않는다. 가져오기 전 브라우저에 이전 작업공간 백업을 남긴다. 새 Mac에서 화면과 관심종목을 확인할 때까지 원본 파일과 기존 브라우저 프로필을 보관한다. `localhost`와 `127.0.0.1`은 브라우저 저장 영역이 다르므로 위 주소를 일관되게 사용한다.

메모와 차트 도구는 상단의 `개인 분석 백업 → JSON 백업 다운로드`로 별도 저장한다. `kiwoom-personal-analysis-backup.json`은 검증된 `hts-note:KR|US:종목코드` 메모와 차트 그리기·지표 템플릿만 담으며 최대 1 MiB다. 새 Mac에서는 파일을 먼저 선택해 메모·차트 범위·충돌 수를 확인한 뒤 `검증한 내용 복원`을 누른다. 기존의 관련 없는 메모·차트 범위는 유지하고 같은 메모 키나 그리기/템플릿 ID만 백업 값으로 병합한다. API 키·시크릿·토큰·SEC 연락처·OpenDART 키·계좌·시세·알림은 이 파일에 포함되지 않는다.

## 저장소에 포함할 것

소스, `backend/uv.lock`, `frontend/package-lock.json`, 설치·실행 스크립트, 테스트와 문서를 포함한다. `data/`, `.env`, 토큰 캐시, 실제 키 파일, 다운로드한 `*_appkey.txt`/`*_appsecret.txt`, `kiwoom-personal-analysis-backup.json`, `kiwoom-hts-workspace*.json`, 사용자 화면 캡처는 포함하지 않는다. 사용자는 원저작자의 공개 GitHub 배포 허락을 확인했으며, 출처·저작자 표기는 릴리스에도 보존한다. 이 문서는 특정 릴리스가 이미 게시되었음을 뜻하지 않고, 원본 전체에 새 공개 라이선스를 부여하지 않는다.

터미널 없이 아이콘으로 실행하는 서명된 Tauri `.app` 패키징은 후속 단계다. 현재 이전 단위는 재현 가능한 소스 설치다.
