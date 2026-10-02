export type TaskStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
export type StepStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';

export type TaskStep = { id: string; title: string; status: StepStatus; progress: number; error?: string };
export type TaskWorkflow = 'legal' | 'document';
export type Task = { id: string; prompt: string; title: string; sourceFileIds: string[]; sourceUrls: string[]; status: TaskStatus; steps: TaskStep[]; createdAt: string; updatedAt: string; workflow?: TaskWorkflow; error?: string };
export type TaskEvent = { id: number; taskId: string; type: string; title: string; message: string; status: string; createdAt: string; metadata?: Record<string, unknown> };
export type Artifact = { id: string; taskId: string; name: string; kind: 'document' | 'data'; mimeType: string; content: string; fileId?: string; createdAt: string };
export type TaskDetails = { task: Task; events: TaskEvent[]; artifacts: Artifact[] };
