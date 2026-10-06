# 한국 법률 지식 런타임

이 디렉터리는 testA의 읽기 전용 법률 검색 구현, Wiki, 온톨로지, OKF 카탈로그를 Workfolio 백엔드에 통합한 런타임입니다. TypeScript API가 Python stdio MCP 프로세스를 실행하며, 결과 답변 생성과 인용 검증은 TypeScript 서비스가 담당합니다.

## 데이터 번들

검색에 필요한 법령·판례 FTS 인덱스, 그래프, 사용 중인 벡터 메모리맵, OKF·온톨로지·Wiki와 판례 원문 번들을 이 프로젝트에 포함합니다. 대용량 바이너리와 압축 원문은 Git LFS로 관리합니다. 구형 2.27GB JSON 벡터 덤프와 중복 Qdrant 저장소는 런타임에서 사용하지 않아 제외했습니다. 원본 testA 자료는 복사만 하며 수정·재색인하지 않습니다.

새 PC에는 Git LFS를 설치한 뒤 저장소를 받은 다음 `npm run legal:data`를 실행하세요. 명령은 LFS 데이터 포인터를 실제 파일로 받고 판례 원문 ZIP을 `backend/legal/data/legal/precedent`에 안전하게 풀어 둡니다. Git LFS를 쓰지 않는 ZIP 다운로드는 LFS 포인터만 포함할 수 있으므로 이 명령이 필요합니다.

저장소에 포함된 번들이 기본값입니다. 기존 testA 원본을 바로 참조하는 개발 예시(PowerShell):

```powershell
$env:LEGAL_DATA_ROOT = 'C:\Users\spear\project\testA\data'
$env:LEGAL_GRAPH_PATH = 'C:\Users\spear\project\testA\data\legal_graph.sqlite3'
$env:LEGAL_ONTOLOGY_PATH = 'C:\Users\spear\project\testA\ontology\legal-wiki.ttl'
$env:OKF_BUNDLE_PATH = 'C:\Users\spear\project\testA\okf\korea-legal'
$env:VECTOR_MEMMAP_PATH = 'C:\Users\spear\project\testA\data\vector_memmap'
$env:QDRANT_PATH = 'C:\Users\spear\project\testA\data\qdrant'
```

Install the Python runtime once. From the repository root, run `npm run setup:legal`; it creates a repository-local `backend/legal/.venv` and installs the listed packages. It does not edit `.env`, download corpus data, or write to an external `LEGAL_RAG_ROOT`. To do the same steps manually:

```powershell
python -m venv backend/legal/.venv
backend/legal/.venv/Scripts/python.exe -m pip install -r backend/legal/requirements.txt
```

Then set `LEGAL_PYTHON` to `backend/legal/.venv/Scripts/python.exe` (Windows) or `backend/legal/.venv/bin/python` (Linux/macOS) in the local `.env` if needed. Run `npm run legal:data` separately to fetch LFS assets and extract precedent source files. The Python entrypoint and runtime modules live directly in `backend/legal/`; `LEGAL_RUNTIME_ROOT` is only needed if they are relocated. Install `requirements-dev.txt` to run `npm run test:legal`. NVIDIA credentials are supplied only through the local ignored `.env` or process environment; never put them in the corpus or Git.

The MCP server verifies prebuilt law and precedent indexes and does not construct or modify them. Missing indexes or unpacked precedent sources are reported as unavailable. Vector retrieval remains dependent on the configured embedding endpoint and the included matching vector bundle. Graph, ontology, and OKF readiness are reported independently.
