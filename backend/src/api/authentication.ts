import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { AppError } from '../shared/app-error.js';

export function createApiAuthToken(): string {
  return randomBytes(32).toString('base64url');
}

export class ApiAuthenticator {
  private readonly expectedDigest?: Buffer;

  constructor(token?: string) {
    if (token === undefined) return;
    if (token.length < 32) throw new Error('API_AUTH_TOKEN must be at least 32 characters');
    this.expectedDigest = createHash('sha256').update(token, 'utf8').digest();
  }

  isAuthorized(header: string | undefined): boolean {
    if (!this.expectedDigest) return true;
    if (!header?.startsWith('Bearer ')) return false;
    const token = header.slice(7);
    if (!token || token.trim() !== token) return false;
    const candidateDigest = createHash('sha256').update(token, 'utf8').digest();
    return timingSafeEqual(this.expectedDigest, candidateDigest);
  }

  requireAuthorized(header: string | undefined): void {
    if (!this.expectedDigest) return;
    if (!this.isAuthorized(header)) throw new AppError(401, 'unauthorized');
  }
}
