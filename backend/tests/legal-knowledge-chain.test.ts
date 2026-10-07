import assert from 'node:assert/strict';
import test from 'node:test';
import { checkEdge, parseOkfPage, parseOntology, precedentsCitingArticle } from '../src/application/legal/legal-knowledge-chain.ts';
import type { LegalSource } from '../src/domain/legal-source.ts';

const TTL = `@prefix legal: <https://knowledge-rag.local/legal/> .
legal:Article a rdfs:Class ;
    rdfs:label "Article" ;
    rdfs:subClassOf legal:LegalDocument .
legal:Precedent a rdfs:Class ;
    rdfs:label "Precedent" ;
    rdfs:subClassOf legal:LegalDocument .
legal:LegalDocument a rdfs:Class ;
    rdfs:label "LegalDocument" .
legal:citesArticle a rdf:Property ;
    rdfs:domain legal:LegalDocument ;
    rdfs:range legal:Article .
legal:decidedBy a rdf:Property ;
    rdfs:domain legal:Precedent ;
    rdfs:range legal:Court .
`;

test('the ontology contract checks relation type, domain and range through the class hierarchy', () => {
  const contract = parseOntology(TTL);
  assert.deepEqual(checkEdge(contract, 'CITES_ARTICLE', 'Precedent', 'Article'), { valid: true, property: 'citesArticle' }, 'a Precedent is a LegalDocument');
  assert.equal(checkEdge(contract, 'DECIDED_BY', 'Article', 'Court').valid, false, 'an article is not decided by a court');
  assert.equal(checkEdge(contract, 'UNKNOWN_EDGE', 'Precedent', 'Article').valid, false, 'undeclared relations are rejected');
});

test('an OKF catalog page yields its type, title and resource', () => {
  assert.deepEqual(parseOkfPage('laws', '---\ntype: Legal Corpus\ntitle: Legal Corpus — Laws\nresource: ../../data/legal/full\n---\n# x'), { key: 'laws', type: 'Legal Corpus', title: 'Legal Corpus — Laws', resource: '../../data/legal/full' });
  assert.equal(parseOkfPage('x', '# no front matter'), null);
});

const edge = (sourcePath: string, targetId: string, targetPath: string, relation = 'CITES_ARTICLE', sourceType = 'Precedent'): LegalSource => ({
  citationId: 'G1', kind: 'graph', corpus: 'graph', recordId: `${sourcePath}:${targetId}`, title: 't', excerpt: 'e',
  graphRelation: { sourceId: 'precedent:1', sourceLabel: '손해배상', sourceType, relation, targetId, targetLabel: '법률 제750조', targetType: 'Article', sourcePath, targetPath }
});

test('precedents citing an article are taken only for the right law, the right article and an allowed relation', () => {
  const contract = parseOntology(TTL);
  const graph = [
    edge('민사/대법원/대법원_1985-03-12_84다501.md', 'law:001706:article:750', 'kr/민법/법률.md'),
    edge('민사/대법원/대법원_1990-01-01_89다1.md', 'law:001706:article:750', 'kr/민법/법률.md'),
    edge('민사/대법원/대법원_2000-01-01_99다9.md', 'law:009999:article:750', 'kr/형법/법률.md'),
    edge('민사/대법원/대법원_2001-01-01_2000다7.md', 'law:001706:article:751', 'kr/민법/법률.md'),
    edge('민사/대법원/대법원_2002-01-01_2001다8.md', 'law:001706:article:750', 'kr/민법/법률.md', 'DECIDED_BY'),
    edge('민사/대법원/대법원_1985-03-12_84다501.md', 'law:001706:article:750', 'kr/민법/법률.md')
  ];
  const found = precedentsCitingArticle(graph, '민법', '제750조', contract, 5);
  assert.deepEqual(found.citations.map(item => item.caseNumber), ['84다501', '89다1'], 'other laws, other articles, other relations and duplicates are skipped');
  assert.equal(found.citations[0]!.court, '대법원');
  assert.equal(found.citations[0]!.property, 'citesArticle');
  assert.equal(found.edges, 3);
  assert.equal(precedentsCitingArticle(graph, '민법', '제750조', contract, 1).citations.length, 1, 'the limit is respected');
});
