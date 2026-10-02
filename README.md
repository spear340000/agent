# Workroom

자료를 모으고 문서 초안을 다듬는 작업 공간의 프론트엔드입니다. 현재는 화면과 작업 흐름을 확인하기 위한 시연 버전입니다.

## 현재 구현 범위

- 작업 생성, 목록·필터, 진행 단계 표시, 사이드바 크기 조절
- 파일·링크 첨부 UI와 자료 목록
- 문서 미리보기, 직접 편집, Markdown·DOCX 다운로드
- 작업과 문서의 브라우저 로컬 저장

작업 진행과 문서 초안은 브라우저에서 모의 실행합니다. 첨부 파일은 이름만 기록하며 실제 업로드·내용 분석은 하지 않습니다. 링크도 수집하지 않습니다. Workroom의 작업 흐름은 아직 백엔드 API에 연결되지 않았습니다.

## 로컬 실행

Node.js 22.12 이상(22 LTS) 또는 24 LTS와 Corepack이 필요합니다. 프로젝트는 pnpm 10.14.0을 사용합니다.

```bash
git clone --branch frontend https://github.com/spear340000/agent.git
cd agent
corepack pnpm install --frozen-lockfile
corepack pnpm dev
```

브라우저에서 http://localhost:3000 을 엽니다. Windows PowerShell에서 Corepack 명령이 실행되지 않으면 `corepack.cmd pnpm`을 사용하세요.

## 주요 파일

| 역할                   | 경로                                    |
| ---------------------- | --------------------------------------- |
| 첫 페이지              | `src/app/page.tsx`                      |
| 화면 상태와 작업 목록  | `src/components/workroom/Workroom.tsx`  |
| 요청·첨부 입력         | `src/components/workroom/Composer.tsx`  |
| 문서 미리보기·다운로드 | `src/components/workroom/Documents.tsx` |
| 시연용 작업 흐름       | `src/api/workroom.ts`                   |
| 화면 스타일            | `src/app/workroom.css`                  |

## 검사

```bash
corepack pnpm run lint
corepack pnpm run format
corepack pnpm run typecheck
```

GitHub Actions는 푸시마다 의존성을 설치하고 lint·format·typecheck를 실행합니다.
