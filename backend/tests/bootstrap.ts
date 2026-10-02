import path from 'node:path';
import { pathToFileURL } from 'node:url';

process.env.NODE_ENV = 'test';
const target = process.argv[2];
await import(target ? pathToFileURL(path.resolve(target)).href : './run.ts');
