import { createApiAuthToken } from '../api/authentication.js';

process.stdout.write(`${createApiAuthToken()}\n`);
