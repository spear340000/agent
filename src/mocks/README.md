# Local mock backend

`backend.ts` contains the temporary in-browser API responses and demo state.
Local development uses it by default; production builds continue to call the
configured backend.

Set `NEXT_PUBLIC_USE_MOCK_BACKEND=false` in `.env.local` and restart the dev
server to switch back to the real backend while developing.

When the real backend is ready, search for `MOCK_BACKEND_ENABLED` and
`mockRequest` to remove the adapter branches from `src/api/workroom.ts`,
`src/components/workroom/Workroom.tsx`, and this folder. The mock task history
is stored only in this browser under `workfolio-mock-backend-v1` and can be
cleared from browser storage independently of backend data.

Mock tasks and tool results are UI examples. They do not run an AI model, read
uploaded files, search legal sources, or control an actual browser or computer.
