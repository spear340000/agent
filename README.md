# Workfolio

문서 작업과 법률 정보 탐색을 위한 TypeScript 웹 앱입니다. 프론트엔드는 Next.js, 백엔드는 별도 TypeScript API 서버로 구성됩니다.

## 실행

Node.js 22.12 이상과 pnpm 10.14.0을 사용합니다.

```bash
corepack pnpm install --frozen-lockfile
corepack pnpm dev
```

프론트엔드는 http://localhost:3000 에서 실행됩니다. 백엔드는 별도 터미널에서 실행합니다.

```powershell
Copy-Item .env.example .env
# .env에 NVIDIA_API_KEY, NVIDIA_BASE_URL, NVIDIA_MODEL 및 LEGAL_RAG_ROOT 설정
corepack pnpm backend
```

API 기본 주소는 `http://127.0.0.1:8787`입니다. provider 키와 API 토큰은 로컬 `.env` 또는 배포 환경의 secret manager에만 설정하세요. `.env`는 Git에서 무시되며 절대 커밋하지 않습니다. `.env.example`에는 실제 키가 없습니다.

법률 코퍼스는 별도로 제공하며 저장소에 포함하지 않습니다. `LEGAL_RAG_ROOT`를 읽기 전용 코퍼스 경로로 지정하세요. 데이터베이스와 업로드·생성 파일은 로컬 `data/` 아래에 저장되며 Git에서 제외됩니다.

## 검사

```bash
corepack pnpm run lint
corepack pnpm run format
corepack pnpm run typecheck
corepack pnpm run check:backend
corepack pnpm run test:backend
corepack pnpm run build:backend
corepack pnpm run test:frontend
```

## 구성

- `src/`: Next.js 프론트엔드
- `backend/src/`: API, 에이전트, 법률 검색 및 문서 도구 서버
- `backend/tests/`: 백엔드 테스트
- `backend/ops/searxng/`: 로컬 SearXNG 실행 설정 (생성되는 `.env`는 커밋하지 않음)
