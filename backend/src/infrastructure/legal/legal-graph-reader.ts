import { DatabaseSync } from 'node:sqlite';
import type { LegalGraphRelation } from '../../domain/legal-source.js';
import { graphRecord, queryTerms, rankByCorpusEvidence } from './legal-normalization.js';
import type { NormalizedRecord } from './legal-normalization.js';

type GraphNodeRow = {
  id: string;
  type: string;
  label: string;
  properties_json: string;
};

type GraphEdgeRow = {
  source_id: string;
  source_type: string;
  source_label: string;
  source_properties: string;
  relation: string;
  target_id: string;
  target_type: string;
  target_label: string;
  target_properties: string;
};

const MAX_SEEDS = 20;
const EDGES_PER_SEED = 40;

/** Searches actual indexed nodes, then reads bounded adjacent edges without writing to the corpus. */
export function searchGraphRelations(
  databasePath: string,
  query: string,
  limit = 10,
  identifiers: readonly string[] = []
): NormalizedRecord[] {
  if (!query.trim()) return [];
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const seeds = findQuerySeeds(database, query);
    const ids = [...seeds.map(seed => seed.id), ...resolveIdentifiers(database, identifiers)];
    const uniqueIds = [...new Set(ids)].slice(0, MAX_SEEDS);
    if (!uniqueIds.length) return [];

    const rows: GraphEdgeRow[] = [];
    const readEdges = database.prepare(`
      SELECT e.source_id, source.type AS source_type, source.label AS source_label,
             source.properties_json AS source_properties, e.relation, e.target_id,
             target.type AS target_type, target.label AS target_label,
             target.properties_json AS target_properties
      FROM edges AS e
      JOIN nodes AS source ON source.id = e.source_id
      JOIN nodes AS target ON target.id = e.target_id
      WHERE e.source_id = ? OR e.target_id = ?
      ORDER BY CASE e.relation
        WHEN 'RELATES_TO' THEN 0
        WHEN 'CITES_ARTICLE' THEN 1
        WHEN 'CITES_LAW' THEN 2
        WHEN 'HAS_ARTICLE' THEN 3
        WHEN 'DERIVED_FROM' THEN 4
        WHEN 'DECIDED_BY' THEN 5
        ELSE 6
      END, e.source_id, e.target_id
      LIMIT ?
    `);

    for (const id of uniqueIds) {
      rows.push(...readEdges.all(id, id, EDGES_PER_SEED) as unknown as GraphEdgeRow[]);
    }

    const uniqueRows = new Map<string, GraphEdgeRow>();
    for (const row of rows) uniqueRows.set(`${row.source_id}\u0000${row.relation}\u0000${row.target_id}`, row);
    const records = [...uniqueRows.values()].map(toRelationRecord);
    const ranked = rankByCorpusEvidence(records, queryTerms(query)).filter(record => (record.relevance ?? 0) > 0);
    return ranked.slice(0, Math.min(Math.max(limit, 1), 30));
  } finally {
    database.close();
  }
}

/** Resolves MCP-returned node IDs or exact aliases and reads only their bounded adjacency. */
export function readGraphRelations(
  databasePath: string,
  nodeIds: readonly string[],
  limit = 20
): NormalizedRecord[] {
  const identifiers = [...new Set(nodeIds.filter(id => /^[\p{L}\p{N}._:#/\\-]{1,240}$/u.test(id)))].slice(0, MAX_SEEDS);
  if (!identifiers.length) return [];
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const ids = resolveIdentifiers(database, identifiers);
    if (!ids.length) return [];
    const placeholders = ids.map(() => '?').join(', ');
    const rows = database.prepare(`
      SELECT e.source_id, source.type AS source_type, source.label AS source_label,
             source.properties_json AS source_properties, e.relation, e.target_id,
             target.type AS target_type, target.label AS target_label,
             target.properties_json AS target_properties
      FROM edges AS e
      JOIN nodes AS source ON source.id = e.source_id
      JOIN nodes AS target ON target.id = e.target_id
      WHERE e.source_id IN (${placeholders}) OR e.target_id IN (${placeholders})
      ORDER BY CASE e.relation
        WHEN 'RELATES_TO' THEN 0 WHEN 'CITES_ARTICLE' THEN 1 WHEN 'CITES_LAW' THEN 2
        WHEN 'HAS_ARTICLE' THEN 3 WHEN 'DERIVED_FROM' THEN 4 WHEN 'DECIDED_BY' THEN 5 ELSE 6
      END, e.source_id, e.target_id
      LIMIT ?
    `).all(...ids, ...ids, Math.min(Math.max(limit, 1), 200)) as unknown as GraphEdgeRow[];
    return [...new Map(rows.map(row => [`${row.source_id}\u0000${row.relation}\u0000${row.target_id}`, row])).values()].map(toRelationRecord);
  } finally {
    database.close();
  }
}

export function graphIdentifiersFromRecords(records: readonly {
  recordId: string;
  lawName?: string;
  articleNumber?: string;
  caseNumber?: string;
  precedentSerial?: string;
  indexPath?: string;
}[]): string[] {
  return [...new Set(records.flatMap(record => [
    record.recordId,
    record.lawName,
    record.articleNumber,
    [record.lawName, record.articleNumber].filter(Boolean).join(' '),
    record.caseNumber,
    record.precedentSerial,
    record.indexPath
  ].filter((value): value is string => Boolean(value))))];
}

function findQuerySeeds(database: DatabaseSync, query: string): GraphNodeRow[] {
  const nodes = runFtsQuery(() => database.prepare(`
      SELECT n.id, n.type, n.label, n.properties_json
      FROM nodes_fts
      JOIN nodes AS n ON n.id = nodes_fts.id
      WHERE nodes_fts MATCH ?
      ORDER BY bm25(nodes_fts), n.id
      LIMIT ?
    `).all(query, MAX_SEEDS) as unknown as GraphNodeRow[]);
  const aliases = runFtsQuery(() => database.prepare(`
      SELECT DISTINCT n.id, n.type, n.label, n.properties_json
      FROM aliases_fts
      JOIN aliases AS a ON a.node_id = aliases_fts.node_id AND a.alias = aliases_fts.alias
      JOIN nodes AS n ON n.id = a.node_id
      WHERE aliases_fts MATCH ?
      ORDER BY bm25(aliases_fts), n.id
      LIMIT ?
    `).all(query, MAX_SEEDS) as unknown as GraphNodeRow[]);
  return [...new Map([...nodes, ...aliases].map(node => [node.id, node])).values()].slice(0, MAX_SEEDS);
}

function runFtsQuery<T>(query: () => T): T | [] {
  try {
    return query();
  } catch (error) {
    if (error instanceof Error && /(?:fts5:.*(?:syntax error|unknown special query)|unterminated string)/iu.test(error.message)) return [];
    throw error;
  }
}

function resolveIdentifiers(database: DatabaseSync, identifiers: readonly string[]): string[] {
  const candidates = identifiers
    .filter(id => /^[\p{L}\p{N}._:#/\\-]{1,240}$/u.test(id))
    .slice(0, MAX_SEEDS * 4);
  if (!candidates.length) return [];
  const placeholders = candidates.map(() => '?').join(', ');
  const nodeRows = database.prepare(`
    SELECT id FROM nodes WHERE id IN (${placeholders}) LIMIT ?
  `).all(...candidates, MAX_SEEDS) as { id: string }[];
  const aliasRows = database.prepare(`
    SELECT alias, node_id AS id FROM aliases WHERE alias IN (${placeholders}) LIMIT ?
  `).all(...candidates, MAX_SEEDS) as { id: string; alias: string }[];
  let ids = candidates.flatMap(candidate => [
    ...nodeRows.filter(row => row.id === candidate).map(row => row.id),
    ...aliasRows.filter(row => row.alias === candidate).map(row => row.id)
  ]);
  const lawById = database.prepare("SELECT id FROM nodes WHERE id = ? AND type = 'Law' LIMIT 1");
  const lawByAlias = database.prepare(`
    SELECT n.id
    FROM aliases AS a
    JOIN nodes AS n ON n.id = a.node_id
    WHERE a.alias = ? AND n.type = 'Law'
    LIMIT 5
  `);
  const articleEdges = database.prepare(`
    SELECT e.target_id AS id
    FROM edges AS e
    JOIN nodes AS target ON target.id = e.target_id
    WHERE e.source_id = ? AND e.relation = 'HAS_ARTICLE' AND target.label = ?
    LIMIT 1
  `);
  const exactArticleParents = new Set<string>();
  for (const candidate of candidates) {
    const separator = candidate.lastIndexOf('#');
    if (separator <= 0) continue;
    const lawName = candidate.slice(0, separator);
    const articleNumber = candidate.slice(separator + 1);
    if (!/^제\d+(?:조의\d+)?조?$/u.test(articleNumber)) continue;
    const laws = [
      ...lawById.all(lawName) as { id: string }[],
      ...lawByAlias.all(lawName) as { id: string }[]
    ];
    for (const law of laws) {
      const articles = articleEdges.all(law.id, `법률 ${articleNumber}`) as { id: string }[];
      if (articles.length) {
        exactArticleParents.add(law.id);
        ids.push(...articles.map(row => row.id));
      }
    }
  }
  if (exactArticleParents.size) ids = ids.filter(id => !exactArticleParents.has(id));
  return [...new Set(ids)].slice(0, MAX_SEEDS);
}

function sourcePath(properties: string): string | undefined {
  try {
    const value: unknown = JSON.parse(properties);
    if (value && typeof value === 'object' && 'path' in value && typeof value.path === 'string') return value.path;
  } catch {
    // Optional provenance cannot invalidate an otherwise sound edge.
  }
  return undefined;
}

function toRelationRecord(row: GraphEdgeRow): NormalizedRecord {
  const sourcePathValue = sourcePath(row.source_properties);
  const targetPathValue = sourcePath(row.target_properties);
  const provenance = sourcePathValue ?? targetPathValue;
  const relation: LegalGraphRelation = {
    sourceId: row.source_id,
    sourceLabel: row.source_label,
    sourceType: row.source_type,
    relation: row.relation,
    targetId: row.target_id,
    targetLabel: row.target_label,
    targetType: row.target_type,
    ...(sourcePathValue ? { sourcePath: sourcePathValue } : {}),
    ...(targetPathValue ? { targetPath: targetPathValue } : {})
  };
  const excerpt = `${row.source_label} —${row.relation}→ ${row.target_label}${provenance ? ` · 출처 ${provenance}` : ''}`;
  return {
    ...graphRecord(`${row.source_id}:${row.relation}:${row.target_id}`, excerpt),
    title: `${row.source_label} —${row.relation}→ ${row.target_label}`,
    graphRelation: relation,
    ...(provenance ? { indexPath: provenance } : {})
  };
}

/**
 * Precedents that cite one specific article, read straight from the graph (read-only). The article is resolved by its
 * number and its source file (kr/<law name>/...), because graph labels only say "법률 제750조". Supreme Court
 * judgments are listed first.
 */
export function readArticleCitations(databasePath: string, lawName: string, articleNumber: string, limit = 20): NormalizedRecord[] {
  const number = /(\d+)(?:조의(\d+))?/.exec(articleNumber.replace(/\s+/g, ''));
  if (!number || !lawName.trim()) return [];
  const suffix = number[2] ? `:article:${number[1]}-${number[2]}` : `:article:${number[1]}`;
  const law = lawName.replace(/\s+/g, '');
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const articles = (database.prepare("SELECT id, properties_json FROM nodes WHERE type = 'Article' AND id LIKE ?").all(`%${suffix}`) as Array<{ id: string; properties_json: string }>)
      .filter(row => (sourcePath(row.properties_json) ?? '').split('/').some(part => part.replace(/\s+/g, '') === law));
    if (articles.length === 0) return [];
    const readCitations = database.prepare(`
      SELECT e.source_id, source.type AS source_type, source.label AS source_label,
             source.properties_json AS source_properties, e.relation, e.target_id,
             target.type AS target_type, target.label AS target_label,
             target.properties_json AS target_properties
      FROM edges AS e
      JOIN nodes AS source ON source.id = e.source_id
      JOIN nodes AS target ON target.id = e.target_id
      WHERE e.target_id = ? AND e.relation = 'CITES_ARTICLE' AND source.type = 'Precedent'
      ORDER BY CASE WHEN source.properties_json LIKE '%대법원%' THEN 0 ELSE 1 END, e.source_id DESC
      LIMIT ?
    `);
    const rows = articles.flatMap(article => readCitations.all(article.id, Math.min(Math.max(limit, 1), 50)) as unknown as GraphEdgeRow[]);
    return rows.map(toRelationRecord);
  } finally {
    database.close();
  }
}
