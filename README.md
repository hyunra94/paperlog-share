# 같이 쓰는 Paper Log (공유 앱)

PaperLog 중 **공개한 프로젝트의 일정**과 **공개한 카테고리의 지출**만 다른 사람과 함께 보고 쓰는 앱이에요.
데이터는 PaperLog와 같은 Notion DB에 저장돼요. 그래서 공유 앱에서 입력한 내용은 PaperLog에도 그대로 보여요.

PaperLog 저장소와는 완전히 따로 있어요. PaperLog 코드나 Worker는 건드리지 않아요.

- 화면: 이 저장소 루트 (`index.html`) → GitHub Pages로 배포하면 `https://hyunra94.github.io/paperlog-share/`
- Worker: `worker/` → `https://paperlog-share.hyunra94.workers.dev`
- PaperLog Worker의 `SECRET_KEY`는 쓰지 않아요. 공유 Worker는 공개 범위 밖의 데이터를 읽지도, 쓰지도 않아요.

## 권한
| 누구 | 할 수 있는 것 |
|---|---|
| 관리자 (ADMIN_KEY로 로그인) | 공유된 모든 항목 보기·수정·삭제, 공유 설정 |
| 멤버 (이름 + 개인 코드) | 공유된 항목 보기, 누구 몫으로든 추가(대신 추가), **담당자 본인이거나 직접 입력한 항목만** 수정·삭제 |

- PaperLog에서 입력한 기존 항목은 담당자가 비어 있으므로 관리자 것으로 봐요.
- 지출의 결제수단(Card)과 일정의 개인 메모, 비공개 프로젝트 이름은 공유 앱에 보이지 않아요.
- 공개된 프로젝트와 비공개 프로젝트가 같이 걸린 일정은 공유 앱에 보여요. 다만 비공개 프로젝트 이름은 나오지 않고, 수정해도 비공개 프로젝트 연결은 그대로 남아요.

## 처음 배포하기
`worker` 폴더에서 실행해요.

```bash
npx wrangler kv namespace create SHARE_KV
```
→ 출력된 id를 `worker/wrangler.toml`의 `REPLACE_WITH_SHARE_KV_ID` 자리에 넣어요.

```bash
npx wrangler secret put NOTION_TOKEN
```
→ PaperLog Worker에 넣은 것과 같은 Notion 토큰을 넣어요.

```bash
npx wrangler secret put ADMIN_KEY
```
→ 공유 앱 관리자 코드예요. **PaperLog SECRET_KEY와 다른 값**으로, 길게 정해 주세요.

```bash
npx wrangler deploy
```

화면은 GitHub 저장소 Settings → Pages에서 `main` 브랜치의 루트(`/`)를 배포 대상으로 고르면 열려요.
다른 주소(예: 직접 연결한 도메인)를 쓰면 `worker/wrangler.toml`의 `CORS_ORIGIN`에 그 주소를 추가해요.

## 처음 설정하기
1. 공유 앱 주소에서 이름은 비워 두고 ADMIN_KEY로 로그인해요.
2. 왼쪽 위 ⚙ → **담당자·작성자 속성 추가하기** 버튼을 눌러요. 일정 DB와 지출 DB에 `공유 담당자`(선택), `공유 작성자`(텍스트) 속성이 생겨요.
3. 내 이름, 공개할 프로젝트와 카테고리, 함께 쓸 사람(이름 + 코드)을 정하고 저장해요.
4. 함께 쓸 사람에게 주소와 각자의 이름, 코드를 알려 주세요.

멤버를 목록에서 빼면 그 사람은 바로 로그아웃돼요.
