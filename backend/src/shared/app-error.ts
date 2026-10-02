export class AppError extends Error {
  constructor(public readonly statusCode: number, message: string, public readonly details?: unknown) { super(message); }
}

export const badRequest = (message: string): AppError => new AppError(400, message);
export const notFound = (message: string): AppError => new AppError(404, message);
export const conflict = (message: string, details?: unknown): AppError => new AppError(409, message, details);
export const unavailable = (message: string): AppError => new AppError(503, message);
