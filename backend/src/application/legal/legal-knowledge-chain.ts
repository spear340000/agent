import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import type { LegalSource } from '../../domain/legal-source.js';

/** A relation the ontology declares: which kind of node it starts from and which kind it points to. */
export type OntologyProperty = { name: string; domain?: string; range?: string };

export type OntologyContract = {
  properties: Map<string, OntologyProperty>;
  /** class -> its declared superclass (rdfs:subClassOf). */
  parents: Map<string, string>;
};

const CLASS_BLOCK = /legal:(\w+)\s+a\s+rdfs:Class\s*;([^.]*)\./g;
const PROPERTY_BLOCK = /legal:(\w+)\s+a\s+rdf:Property\s*;([^.]*)\./g;

/** Reads the class hierarchy and the property domain/range declarations from the legal ontology (Turtle). */
export function parseOntology(ttl: string): OntologyContract {
  const parents = new Map<string, string>();
  for (const match of ttl.matchAll(CLASS_BLOCK)) {
    const parent = /rdfs:subClassOf\s+legal:(\w+)/.exec(match[2]!)?.[1];
    if (parent) parents.set(match[1]!, parent);
  }
  const properties = new Map<string, OntologyProperty>();
  for (const match of ttl.matchAll(PROPERTY_BLOCK)) {
    const domain = /rdfs:domain\s+legal:(\w+)/.exec(match[2]!)?.[1];
    const range = /rdfs:range\s+legal:(\w+)/.exec(match[2]!)?.[1];
    properties.set(match[1]!, { name: match[1]!, ...(domain ? { domain } : {}), ...(range ? { range } : {}) });
  }
  return { properties, parents };
}

/** CITES_ARTICLE -> citesArticle, the ontology's name for the graph's relation label. */
export function ontologyPropertyName(relation: string): string {
  return relation.toLowerCase().replace(/_([a-z])/g, (_match, letter: string) => letter.toUpperCase());
}

function isA(contract: OntologyContract, type: string, expected: string): boolean {
  const seen = new Set<string>();
  for (let current: string | undefined = type; current && !seen.has(current); current = contract.parents.get(current)) {
    if (current === expected) return true;
    seen.add(current);
  }
  return false;
}

/** Whether a graph edge is a relation the ontology declares, between node types it allows. */
export function checkEdge(contract: OntologyContract, relation: string, sourceType: string, targetType: string): { valid: boolean; property: string } {
  const property = contract.properties.get(ontologyPropertyName(relation));
  if (!property) return { valid: false, property: ontologyPropertyName(relation) };
  const domainOk = !property.domain || isA(contract, sourceType, property.domain);
  const rangeOk = !property.range || isA(contract, targetType, property.range);
  return { valid: domainOk && rangeOk, property: property.name };
}

export type OkfEntry = { key: string; type: string; title: string; resource?: string };

/** Reads the OKF catalog pages (front matter: type, title, resource) that describe each corpus. */
export function parseOkfPage(key: string, markdown: string): OkfEntry | null {
  const field = (name: string): string | undefined => new RegExp(`^${name}:\\s*(.+)$`, 'm').exec(markdown)?.[1]?.trim();
  const title = field('title');
  if (!title) return null;
  const resource = field('resource');
  return { key, type: field('type') ?? 'Document', title, ...(resource ? { resource } : {}) };
}

/** A precedent the graph says cites an article, with what is needed to fetch and check it. */
export type GraphCitation = { caseNumber: string; caseName: string; court?: string; relation: string; property: string };

const CASE_FROM_PATH = /_(\d{2,4}[가-힣]{1,4}\d+)\.md$/u;
const COURT_FROM_PATH = /\/([^/]+)\/[^/]+$/u;
const squash = (value: string): string => value.replace(/\s+/g, '');

/**
 * Picks, from graph search results, the precedents that cite one specific article. The graph labels articles only as
 * "법률 제750조", so the law is confirmed from the article's source path (kr/<법령명>/법률.md) and each edge must be a
 * relation the ontology allows (a LegalDocument citing an Article).
 */
export function precedentsCitingArticle(graph: readonly LegalSource[], lawName: string, articleNumber: string, contract: OntologyContract | null, max: number): { citations: GraphCitation[]; edges: number; validated: number } {
  const number = /(\d+)(?:조의(\d+))?/.exec(articleNumber.replace(/\s+/g, ''));
  if (!number) return { citations: [], edges: 0, validated: 0 };
  const articleId = number[2] ? `${number[1]}-${number[2]}` : number[1]!;
  const law = squash(lawName);
  let edges = 0;
  let validated = 0;
  const citations: GraphCitation[] = [];
  const seen = new Set<string>();
  for (const source of graph) {
    const relation = source.graphRelation;
    if (!relation || relation.relation !== 'CITES_ARTICLE' || relation.sourceType !== 'Precedent') continue;
    const target = /article:(\d+)(?:-(\d+))?$/.exec(relation.targetId);
    const targetArticle = target ? (target[2] ? `${target[1]}-${target[2]}` : target[1]) : undefined;
    const targetLaw = squash(relation.targetPath?.split('/').slice(-2, -1)[0] ?? '');
    if (targetArticle !== articleId || !targetLaw || targetLaw !== law) continue;
    edges += 1;
    const check = contract ? checkEdge(contract, relation.relation, relation.sourceType, relation.targetType) : { valid: true, property: ontologyPropertyName(relation.relation) };
    if (!check.valid) continue;
    validated += 1;
    const caseNumber = CASE_FROM_PATH.exec(relation.sourcePath ?? '')?.[1];
    if (!caseNumber || seen.has(caseNumber) || citations.length >= max) continue;
    seen.add(caseNumber);
    const court = COURT_FROM_PATH.exec(relation.sourcePath ?? '')?.[1];
    citations.push({ caseNumber, caseName: relation.sourceLabel, ...(court ? { court } : {}), relation: relation.relation, property: check.property });
  }
  return { citations, edges, validated };
}

/** Ontology contract and OKF catalog, loaded once from the legal runtime folders; missing files just disable them. */
export class LegalKnowledgeChain {
  private ontology?: Promise<OntologyContract | null>;
  private okf?: Promise<Map<string, OkfEntry>>;

  constructor(private readonly paths: { ontology?: string; okf?: string }) {}

  loadOntology(): Promise<OntologyContract | null> {
    this.ontology ??= (async () => {
      if (!this.paths.ontology) return null;
      const contract = parseOntology(await readFile(this.paths.ontology, 'utf8'));
      return contract.properties.size > 0 ? contract : null;
    })().catch(() => null);
    return this.ontology;
  }

  loadOkf(): Promise<Map<string, OkfEntry>> {
    this.okf ??= (async () => {
      const entries = new Map<string, OkfEntry>();
      if (!this.paths.okf) return entries;
      for (const name of (await readdir(this.paths.okf)).filter(file => file.endsWith('.md'))) {
        const entry = parseOkfPage(name.replace(/\.md$/, ''), await readFile(path.join(this.paths.okf, name), 'utf8'));
        if (entry) entries.set(entry.key, entry);
      }
      return entries;
    })().catch(() => new Map<string, OkfEntry>());
    return this.okf;
  }
}
