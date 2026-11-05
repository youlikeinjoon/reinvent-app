# re:Invent 2026 출장 일정 웹앱

홈 화면에 설치해서 쓰는 출장 일정·장소 안내 웹앱입니다.
일정 데이터는 비밀번호로 암호화된 `data.enc.json`에만 들어 있고, 이 저장소에 평문으로 올리지 않습니다.

## 설치

- **아이폰:** Safari에서 앱 주소 열기 → 공유 버튼 → **홈 화면에 추가**
- **안드로이드:** Chrome에서 앱 주소 열기 → ⋮ → **홈 화면에 추가** 또는 **앱 설치**

처음 열 때 비밀번호를 한 번 입력하면 그 기기에 기억됩니다.

## 동작 방식

- 앱을 열거나 상단 동기화 버튼을 누르면 최신 `data.enc.json`을 받아 기기에 저장합니다.
- 인터넷이 끊기면 마지막으로 받은 내용을 보여줍니다(화면 파일은 서비스워커가 저장).
- 앱은 보기 전용입니다. 일정 수정은 원본 플래너에서 합니다.

## 데이터 갱신 (관리자용)

원본 플래너의 데이터를 읽어 `tools/sync.mjs`로 암호화합니다. 비밀번호는 `SYNC_PIN` 환경변수로만 넘기고 어디에도 저장하지 않습니다.

```bash
# 처음 만들기: 원본 문서를 sessions.jsonl / places.jsonl / meta.jsonl (한 줄에 {id, version, updatedAt, data})로 준비
SYNC_PIN=… node tools/sync.mjs build --raw <폴더> --source-url <원본 주소>

# 바뀐 것만 반영: 현재 id·version 목록 확인
SYNC_PIN=… node tools/sync.mjs manifest

# 바뀌거나 새로 생긴 문서만 delta 폴더에 담고, 현재 남아 있는 전체 id 목록(ids.json)을 함께 넘김
SYNC_PIN=… node tools/sync.mjs update --delta <폴더> --ids <ids.json>
```

`ids.json` 형식: `{"sessions": [...], "places": [...], "meta": [...]}` — 목록에 없는 id는 삭제됩니다.
변경이 없으면 파일을 다시 쓰지 않습니다. 원본 JSONL 파일은 `.gitignore`로 제외되어 있으니 커밋하지 마세요.

화면 파일(`index.html`, `app.js`, `styles.css`)을 고치면 `sw.js`의 `CACHE` 이름을 올려야 설치된 앱에 반영됩니다.
