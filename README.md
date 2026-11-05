# re:Invent 2026 출장 일정 웹앱

홈 화면에 설치해서 쓰는 출장 일정·장소 앱입니다. 데이터는 Firebase(Firestore)에 있고, 고치면 모두의 폰에 바로 반영됩니다.

## 설치

- **아이폰:** Safari에서 앱 주소 열기 → 공유 버튼 → **홈 화면에 추가**
- **안드로이드:** Chrome에서 앱 주소 열기 → ⋮ → **홈 화면에 추가** 또는 **앱 설치**

처음 열 때 보기 비밀번호를 한 번 넣으면 그 기기에 기억됩니다.

## 동작 방식

- **보기:** 보기 비밀번호로 공용 계정(`viewer@example.com`)에 로그인합니다. Firestore 규칙이 이 계정만 읽고 쓸 수 있게 막습니다.
- **오프라인:** 받은 데이터는 기기에 저장되어 인터넷이 없어도 보입니다. 오프라인에서 고친 내용은 연결되면 자동으로 올라갑니다.
- **편집:** 위쪽 **편집** → 편집 비밀번호를 넣으면 추가·수정·삭제할 수 있습니다. 편집 비밀번호는 실수 방지용이며 처음 편집할 때 앱에서 정합니다.

## 파일

| 파일 | 내용 |
|---|---|
| `index.html`, `app.js`, `styles.css` | 앱 화면과 동작 |
| `firebase-config.js` | Firebase 웹 앱 설정값(공개 식별값)과 보기 계정 |
| `vendor/firebase.js` | Firebase SDK 묶음(오프라인에서도 앱이 열리도록 함께 배포) |
| `sw.js`, `manifest.webmanifest`, `icons/` | 홈 화면 설치·오프라인용 |
| `firestore.rules` | Firestore 보안 규칙(콘솔에 붙여넣은 것과 같은 내용) |
| `tools/migrate.py` | 처음 한 번 기존 데이터를 Firestore로 옮긴 도구 |

화면 파일을 고치면 `sw.js`의 `CACHE` 이름을 올려야 설치된 앱에 반영됩니다.
`vendor/firebase.js`는 `firebase` npm 패키지(12.x)를 esbuild로 묶은 파일입니다.
