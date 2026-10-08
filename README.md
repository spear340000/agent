# Workroom

법령·판례를 검색하고 문서 초안을 다듬는 작업 공간의 프론트엔드입니다. 작업 실행과 파일 처리는 연결된 백엔드 API에서 수행합니다.

## 현재 구현 범위

- 작업 생성, 목록·필터, 진행 단계 표시, 사이드바 크기 조절
- 파일·링크 첨부 UI와 자료 목록
- 문서 미리보기, 직접 편집, Markdown·DOCX·Excel·PDF 다운로드
- 실제 작업 진행·검색 근거 표시, 저장 전 문서의 로컬 복구
- RAG 검색, 읽기 전용 Wiki, 온톨로지·그래프 조회

백엔드 연결 설정에서 실행 중인 서버의 주소를 지정합니다. 모델을 사용하는 답변·문서 생성에는 백엔드의 모델 API 키가 필요합니다. 파일 업로드, 자료 조회, Markdown에서 Word 생성 등은 모델 호출 없이 실행할 수 있습니다. 검색·OCR·브라우저 도구의 사용 가능 여부는 백엔드 설정에 따라 달라집니다.

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

| 역할                  | 경로                                            |
| --------------------- | ----------------------------------------------- |
| 첫 페이지             | `src/app/page.tsx`                              |
| 화면 상태와 작업 목록 | `src/components/workroom/Workroom.tsx`          |
| 요청·첨부 입력        | `src/components/workroom/Composer.tsx`          |
| 문서 미리보기·편집    | `src/components/workroom/DocumentWorkspace.tsx` |
| 백엔드 작업·파일 API  | `src/api/workroom.ts`                           |
| 화면 스타일           | `src/app/workroom.css`                          |

## 검사

```bash
corepack pnpm run lint
corepack pnpm run format
corepack pnpm run typecheck
corepack pnpm run test:unit
corepack pnpm run validate
```

`test:unit`은 `src`의 테스트 파일을 찾아 Node.js 테스트 러너와 tsx로 실행합니다. GitHub Actions는 푸시마다 의존성을 설치하고 `validate`로 lint·format·typecheck·단위테스트를 실행합니다.
