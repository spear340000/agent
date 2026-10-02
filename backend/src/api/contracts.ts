import { badRequest } from '../shared/app-error.js';
import type { BrowserAction } from '../tools/browser-use.js';
import type { ComputerAction } from '../tools/computer-use.js';
import type { SpreadsheetOperation } from '../application/spreadsheet-service.js';

export const asString = (value: unknown, field: string, required = false): string | undefined => {
  if (value === undefined && !required) return undefined;
  if (typeof value !== 'string') throw badRequest(`${field} must be a string`);
  return value;
};

export const taskWorkflow = (value: unknown): 'legal' | 'document' | undefined => {
  if (value === undefined) return undefined;
  if (value === 'legal' || value === 'document') return value;
  throw badRequest('workflow must be legal or document');
};

export const taskInput = (body: Record<string, unknown>): { prompt: string; title?: string; sourceFileIds?: string[]; sourceUrls?: string[]; workflow?: 'legal' | 'document' } => {
  if (body.sourceFileIds !== undefined && (!Array.isArray(body.sourceFileIds) || !body.sourceFileIds.every(id => typeof id === 'string'))) throw badRequest('sourceFileIds must be a string array');
  if (body.sourceUrls !== undefined && (!Array.isArray(body.sourceUrls) || !body.sourceUrls.every(value => typeof value === 'string'))) throw badRequest('sourceUrls must contain valid HTTP(S) URLs');
  const sourceUrls = body.sourceUrls as string[] | undefined;
  if (sourceUrls && sourceUrls.length > 5) throw badRequest('at most 5 source URLs are allowed');
  for (const value of sourceUrls ?? []) {
    try {
      const url = new URL(value);
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || value.length > 2_048) throw new Error('invalid URL');
    } catch { throw badRequest('sourceUrls must contain valid HTTP(S) URLs'); }
  }
  const prompt = asString(body.prompt, 'prompt', true)!;
  if (prompt.length > 12_000) throw badRequest('prompt must be at most 12000 characters');
  const workflow = taskWorkflow(body.workflow);
  return { prompt, title: asString(body.title, 'title'), sourceFileIds: body.sourceFileIds as string[] | undefined, sourceUrls, ...(workflow ? { workflow } : {}) };
};
export const taskRevisionInput = (body: Record<string, unknown>): { kind: 'revision' | 'followup'; message: string; sourceFileIds?: string[]; sourceUrls?: string[] } => {
  if (body.kind !== 'revision' && body.kind !== 'followup') throw badRequest('kind must be revision or followup');
  const message = asString(body.message, 'message', true)!.trim();
  if (!message || message.length > 12_000) throw badRequest('message must contain 1 to 12000 characters');
  const parsed = taskInput({ prompt: message, sourceFileIds: body.sourceFileIds, sourceUrls: body.sourceUrls });
  return { kind: body.kind, message, sourceFileIds: parsed.sourceFileIds, sourceUrls: parsed.sourceUrls };
};
export const browserUrl = (value: unknown): string => {
  const url = asString(value, 'url', true)!;
  if (url.length > 2_048) throw badRequest('url must be at most 2048 characters');
  return url;
};
export const browserAction = (body: Record<string, unknown>): BrowserAction => {
  const selector = (value: unknown): string => {
    if (typeof value !== 'string' || !value.trim() || value.length > 2_000) throw badRequest('selector is required and must be at most 2000 characters');
    return value;
  };
  switch (body.kind) {
    case 'navigate': return { kind: 'navigate', url: browserUrl(body.url) };
    case 'click': return { kind: 'click', selector: selector(body.selector) };
    case 'type': {
      const text = asString(body.text, 'text', true)!;
      if (text.length > 100_000) throw badRequest('text must be at most 100000 characters');
      return { kind: 'type', selector: selector(body.selector), text };
    }
    case 'extractText': return { kind: 'extractText', ...(body.selector === undefined ? {} : { selector: selector(body.selector) }) };
    case 'screenshot': return { kind: 'screenshot' };
    default: throw badRequest('unsupported browser action');
  }
};
export const computerAction = (body: Record<string, unknown>): ComputerAction => {
  if (!body.action || typeof body.action !== 'object' || Array.isArray(body.action)) throw badRequest('action must be an object');
  const action = body.action as Record<string, unknown>;
  if (action.kind === 'screenshot') return { kind: 'screenshot' };
  if (action.kind === 'click') {
    const { x, y } = action;
    if (typeof x !== 'number' || typeof y !== 'number' || !Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0 || x > 20_000 || y > 20_000) throw badRequest('coordinates must be between 0 and 20000');
    return { kind: 'click', x, y };
  }
  if (action.kind === 'type') {
    const text = asString(action.text, 'text', true)!;
    if (text.length > 10_000) throw badRequest('text must be at most 10000 characters');
    return { kind: 'type', text };
  }
  throw badRequest('unsupported computer action');
};

export function spreadsheetOperations(value: unknown): SpreadsheetOperation[] {
  if (!Array.isArray(value) || !value.length) throw badRequest('operations must be a non-empty array');
  for (const raw of value) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw badRequest('each spreadsheet operation must be an object');
    const operation = raw as Record<string, unknown>;
    if (operation.kind === 'addSheet') {
      if (typeof operation.name !== 'string') throw badRequest('addSheet requires a name');
      continue;
    }
    if (typeof operation.sheet !== 'string') throw badRequest('spreadsheet operation requires a sheet');
    if (operation.kind === 'setCell' && (typeof operation.cell !== 'string' || !['string', 'number', 'boolean'].includes(typeof operation.value) && operation.value !== null)) throw badRequest('setCell requires a cell and a scalar value');
    if (operation.kind === 'setFormula' && (typeof operation.cell !== 'string' || typeof operation.formula !== 'string')) throw badRequest('setFormula requires a cell and formula');
    if (operation.kind === 'appendRows' && (!Array.isArray(operation.rows) || operation.rows.some(row => !Array.isArray(row)))) throw badRequest('appendRows requires an array of rows');
    if (!['setCell', 'setFormula', 'appendRows'].includes(String(operation.kind))) throw badRequest('unsupported spreadsheet operation');
  }
  return value as SpreadsheetOperation[];
}

export function spreadsheetInspectInput(body: Record<string, unknown>): { fileId: string; sheet?: string; range?: string } {
  return {
    fileId: asString(body.fileId, 'fileId', true)!,
    ...(body.sheet === undefined ? {} : { sheet: asString(body.sheet, 'sheet', true)! }),
    ...(body.range === undefined ? {} : { range: asString(body.range, 'range', true)! }),
  };
}
