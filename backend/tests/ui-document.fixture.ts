// Explicit manual fixture for UI editing checks. It is not a model-generated result.
import { env } from '../src/config/env.js';
import { SqliteTaskRepository } from '../src/infrastructure/persistence/sqlite-task-repository.js';
import { LocalFileStorage } from '../src/infrastructure/storage/local-file-storage.js';
import { DocumentService } from '../src/application/document-service.js';

const tasks = new SqliteTaskRepository(env.databaseFile);
try {
  const markdown = '# Workfolio UI 검증 문서\n\n이 문서는 편집·저장·크기 조절을 검증하는 수동 테스트 자료입니다. AI가 생성한 문서가 아닙니다.\n\n## 편집 검증\n원본과 새 문서 버전을 구분합니다.\n\n## 다운로드 검증\n실제 DOCX 파일로 저장합니다.';
  const task = tasks.createTask('수동 UI 검증 자료: 문서 편집과 저장을 확인합니다.', 'Workfolio UI 검증 자료');
  const file = await new DocumentService(new LocalFileStorage()).createMarkdownReport({ outputName: 'Workfolio UI 검증 문서', markdown });
  tasks.addArtifact(task.id, { kind: 'document', name: file.name, content: markdown, mimeType: file.mimeType, fileId: file.id });
  tasks.updateTask(task.id, { status: 'completed' });
  console.log(JSON.stringify({ fixtureTaskId: task.id, manuallyCreated: true }));
} finally { tasks.close(); }
