export type ManagedFile = { id: string; name: string; mimeType: string; bytes: number; createdAt: string; path: string };
export interface FileStorage {
  list?(): Promise<ManagedFile[]>;
  save(input: { name: string; mimeType: string; content: Uint8Array }): Promise<ManagedFile>;
  get(id: string): Promise<ManagedFile | null>;
  read(id: string): Promise<{ metadata: ManagedFile; content: Uint8Array }>;
}
