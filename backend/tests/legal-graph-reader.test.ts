import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { readGraphRelations, searchGraphRelations } from '../src/infrastructure/legal/legal-graph-reader.ts';

test('graph search returns real ranked edges from a read-only SQLite graph', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'workfolio-graph-'));
  const file = path.join(directory, 'graph.sqlite3');
  const db = new DatabaseSync(file);
  db.exec(`
    CREATE TABLE nodes (id TEXT PRIMARY KEY, type TEXT NOT NULL, label TEXT NOT NULL, properties_json TEXT NOT NULL DEFAULT '{}', source_id TEXT);
    CREATE TABLE edges (source_id TEXT NOT NULL, relation TEXT NOT NULL, target_id TEXT NOT NULL, properties_json TEXT NOT NULL DEFAULT '{}', PRIMARY KEY(source_id, relation, target_id));
    CREATE TABLE aliases (alias TEXT NOT NULL, node_id TEXT NOT NULL, PRIMARY KEY(alias, node_id));
    CREATE VIRTUAL TABLE nodes_fts USING fts5(id UNINDEXED, label);
    CREATE VIRTUAL TABLE aliases_fts USING fts5(node_id UNINDEXED, alias);
    CREATE INDEX edges_source_relation_idx ON edges(source_id, relation);
    CREATE INDEX edges_target_relation_idx ON edges(target_id, relation);
    CREATE INDEX aliases_alias_idx ON aliases(alias);
  `);
  const insertNode = db.prepare('INSERT INTO nodes(id,type,label,properties_json) VALUES(?,?,?,?)');
  const insertNodeFts = db.prepare('INSERT INTO nodes_fts(id,label) VALUES(?,?)');
  const insertAlias = db.prepare('INSERT INTO aliases(alias,node_id) VALUES(?,?)');
  const insertAliasFts = db.prepare('INSERT INTO aliases_fts(node_id,alias) VALUES(?,?)');
  const insertEdge = db.prepare('INSERT INTO edges(source_id,relation,target_id) VALUES(?,?,?)');
  const nodes = [
    ['case:1', 'Precedent', '손해배상 불법행위 사건', JSON.stringify({ path: '민사/대법원/2024-01-01-case.md' })],
    ['concept:1', 'LegalConcept', '불법행위', '{}'],
    ['source:1', 'Source', '원문 파일', JSON.stringify({ path: '민사/대법원/2024-01-01-case.md' })],
    ['court:1', 'Court', '대법원', '{}'],
    ['law:1', 'Law', '법률', JSON.stringify({ path: 'kr/민법/법률.md' })],
    ['article:1', 'Article', '법률 제750조', '{}']
  ] as const;
  for (const [id, type, label, properties] of nodes) {
    insertNode.run(id, type, label, properties);
    insertNodeFts.run(id, label);
  }
  for (const [alias, id] of [['손해배상 불법행위 사건', 'case:1'], ['민법', 'law:1'], ['제750조', 'article:1']]) {
    insertAlias.run(alias, id);
    insertAliasFts.run(id, alias);
  }
  for (const edge of [
    ['case:1', 'RELATES_TO', 'concept:1'],
    ['case:1', 'DERIVED_FROM', 'source:1'],
    ['case:1', 'DECIDED_BY', 'court:1'],
    ['case:1', 'CITES_ARTICLE', 'article:1'],
    ['law:1', 'HAS_ARTICLE', 'article:1']
  ]) insertEdge.run(...edge);
  db.close();

  try {
    const matches = searchGraphRelations(file, '불법행위 손해배상', 10);
    assert.equal(matches[0]?.graphRelation?.relation, 'RELATES_TO');
    assert.ok(matches.some(item => item.graphRelation?.relation === 'CITES_ARTICLE'));
    assert.ok(matches.every(item => item.corpus === 'graph' && item.graphRelation));
    assert.ok(matches[0]?.excerpt.includes('민사/대법원/2024-01-01-case.md'));

    const exactArticle = searchGraphRelations(file, '민법 제750조', 10, ['민법#제750조']);
    assert.ok(exactArticle.some(item => item.graphRelation?.targetId === 'article:1'));
    assert.ok(exactArticle.every(item => !item.title.includes('제7500조')));

    const byAlias = readGraphRelations(file, ['민법'], 10);
    assert.ok(byAlias.some(item => item.graphRelation?.relation === 'HAS_ARTICLE'));
    assert.deepEqual(searchGraphRelations(file, '"', 10), []);
    const verify = new DatabaseSync(file, { readOnly: true });
    assert.equal(verify.prepare('SELECT COUNT(*) AS count FROM edges').get()?.count, 5);
    verify.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
