# 한국 법률 지식 런타임

이 디렉터리는 testA의 읽기 전용 법률 검색 구현, Wiki, 온톨로지, OKF 카탈로그를 Workfolio 백엔드에 통합한 런타임입니다. TypeScript API가 Python stdio MCP 프로세스를 실행하며, 결과 답변 생성과 인용 검증은 TypeScript 서비스가 담당합니다.

## 데이터 번들

색인 데이터는 Git에 포함하지 않습니다. testA의 데이터 전체가 약 8.2GB이고, SQLite FTS 인덱스만으로도 약 784MB이며, 판례 원문 색인은 별도 원문 파일 경로를 참조합니다. 다른 환경에 배포할 때는 동일한 읽기 전용 번들을 별도 전달한 뒤 `LEGAL_DATA_ROOT`를 그 안의 `data` 디렉터리로 지정해야 합니다. 번들의 파일을 복사하거나 다시 색인할 때는 이 프로젝트가 원본 testA 데이터를 변경하지 않습니다.

현재 testA 번들 사용 예시(PowerShell):

```powershell
$env:LEGAL_DATA_ROOT = 'C:\Users\spear\project\testA\data'
$env:LEGAL_GRAPH_PATH = 'C:\Users\spear\project\testA\data\legal_graph.sqlite3'
$env:LEGAL_ONTOLOGY_PATH = 'C:\Users\spear\project\testA\ontology\legal-wiki.ttl'
$env:OKF_BUNDLE_PATH = 'C:\Users\spear\project\testA\okf\korea-legal'
$env:VECTOR_MEMMAP_PATH = 'C:\Users\spear\project\testA\data\vector_memmap'
$env:QDRANT_PATH = 'C:\Users\spear\project\testA\data\qdrant'
```

Install the Python runtime once:

```powershell
python -m venv backend/legal/.venv
backend/legal/.venv/Scripts/python.exe -m pip install -r backend/legal/requirements.txt
```

Then set `LEGAL_PYTHON` to `backend/legal/.venv/Scripts/python.exe` (Windows) or `backend/legal/.venv/bin/python` (Linux/macOS). The Python entrypoint and runtime modules live directly in `backend/legal/`; `LEGAL_RUNTIME_ROOT` is only needed if they are relocated. Install `requirements-dev.txt` to run `npm run test:legal`. NVIDIA credentials are supplied only through the local ignored `.env` or process environment; never put them in the corpus or Git.

The MCP server verifies prebuilt law and precedent indexes and does not construct or modify them. Missing indexes are reported as unavailable. Vector retrieval remains dependent on the configured embedding endpoint and the matching local vector bundle. Graph, ontology, and OKF readiness are reported independently.
