# Workroom 프론트엔드 작업 안내

첫 화면은 `src/app/page.tsx`에서 `src/components/workroom/Workroom.tsx`를 불러옵니다. 입력창과 문서 패널은 같은 폴더의 `Composer.tsx`, `Documents.tsx`에 있고, 시연용 작업 진행은 `src/api/workroom.ts`에 있습니다.

화면 동작을 바꿀 때는 관련 컴포넌트와 스타일(`src/app/workroom.css`)을 함께 확인해 주세요. 현재 첨부 파일은 이름만 저장하고 링크는 수집하지 않습니다. 실제 API 연결이나 파일 처리를 추가하면 README의 구현 범위도 갱신해 주세요.

변경 사항을 공유하기 전에 아래 명령으로 확인합니다.

```bash
corepack pnpm install --frozen-lockfile
corepack pnpm run lint
corepack pnpm run format
corepack pnpm run typecheck
```

화면을 바꿨다면 브라우저에서 해당 흐름도 확인하고, 어떤 동작을 바꿨는지와 확인 결과를 변경 내용에 적어 주세요.

원 코드에서 유지된 저작권·라이선스 고지는 [LICENSE](./LICENSE)를 따릅니다.
