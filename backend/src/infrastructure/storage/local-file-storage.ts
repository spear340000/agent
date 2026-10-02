import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { FileStorage, ManagedFile } from '../../domain/managed-file.js';
import { notFound } from '../../shared/app-error.js';

type Index = Record<string, ManagedFile>;
export class LocalFileStorage implements FileStorage {
  private readonly indexPath: string;
  private writeQueue: Promise<void> = Promise.resolve();
  constructor(private readonly root = path.resolve('data', 'files')) { this.indexPath = path.join(root, 'index.json'); }
  async save(input: { name: string; mimeType: string; content: Uint8Array }): Promise<ManagedFile> {
    await mkdir(this.root, { recursive: true });
    const id = `file_${randomUUID()}`;
    const displayName = path.win32.basename(path.posix.basename(input.name)).normalize('NFC').replace(/[<>:"/\\|?*\u0000-\u001f\u007f]/g, '_').replace(/[. ]+$/g, '') || 'upload.bin';
    const extension = Array.from(path.extname(displayName)).slice(0, 32).join('');
    const stem = displayName.slice(0, displayName.length - path.extname(displayName).length);
    const safeName = `${Array.from(stem).slice(0, 150 - Array.from(extension).length).join('')}${extension}`;
    // Display names are independent of storage paths, including Korean and Windows device names.
    const relativePath = `${id}${path.extname(safeName).replace(/[^a-zA-Z0-9.]/g, '_')}`;
    const metadata: ManagedFile = { id, name: safeName, mimeType: input.mimeType, bytes: input.content.length, createdAt: new Date().toISOString(), path: relativePath };
    await writeFile(path.join(this.root, relativePath), input.content, { flag: 'wx' });
    const update = this.writeQueue.then(async () => { const index = await this.loadIndex(); index[id] = metadata; await this.writeIndex(index); });
    this.writeQueue = update.catch(() => undefined);
    await update;
    return metadata;
  }
  async get(id: string): Promise<ManagedFile | null> { return (await this.loadIndex())[id] ?? null; }
  async list(): Promise<ManagedFile[]> {
    return Object.values(await this.loadIndex()).sort((left, right) => right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id));
  }
  async read(id: string): Promise<{ metadata: ManagedFile; content: Uint8Array }> {
    const metadata = await this.get(id); if (!metadata) throw notFound('file not found');
    const root = path.resolve(this.root); const target = path.resolve(root, metadata.path);
    if (!target.startsWith(`${root}${path.sep}`)) throw new Error('invalid managed file path');
    return { metadata, content: await readFile(target) };
  }
  private async loadIndex(): Promise<Index> {
    try {
      const parsed: unknown = JSON.parse(await readFile(this.indexPath, 'utf8'));
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('managed file index is invalid');
      return parsed as Index;
    } catch (error) { if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return {}; throw error; }
  }
  private async writeIndex(index: Index): Promise<void> {
    const temporary = `${this.indexPath}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify(index), { flag: 'wx' });
      for (let attempt = 0; ; attempt++) {
        try { await rename(temporary, this.indexPath); return; }
        catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (!['EPERM', 'EACCES', 'EBUSY'].includes(code ?? '') || attempt >= 3) throw error;
          await new Promise(resolve => setTimeout(resolve, 10 * (attempt + 1)));
        }
      }
    } finally { await rm(temporary, { force: true }); }
  }
}
