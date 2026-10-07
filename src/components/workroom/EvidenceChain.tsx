import React from 'react'
import type { LegalChainStage } from '@/api/workroom'

/** Short names for the knowledge layers, in the order a record can pass through them. */
const LAYER_RULES: { label: string; test: (route: string) => boolean }[] = [
  { label: 'Wiki', test: (route) => route.startsWith('LLM Wiki') },
  { label: 'RAG', test: (route) => route.startsWith('RAG') },
  { label: '질의 재작성', test: (route) => route.startsWith('질의 재작성') },
  { label: 'RAG 재검색', test: (route) => route.startsWith('근거가') },
  { label: '그래프', test: (route) => route.includes('관계 그래프') },
  { label: '온톨로지', test: (route) => route.includes('온톨로지') },
  { label: 'MCP', test: (route) => route.includes('MCP') },
  { label: 'OKF', test: (route) => route.startsWith('OKF') }
]

/**
 * The layers a cited record went through, as short labels in the order they appear in its recorded route, so the
 * reader can see at a glance that, for example, a precedent came from the graph and was checked against the ontology.
 */
export function routeLayers(
  provenance: readonly string[] | undefined
): string[] {
  const layers: string[] = []
  for (const route of provenance ?? []) {
    for (const rule of LAYER_RULES) {
      if (rule.test(route) && !layers.includes(rule.label))
        layers.push(rule.label)
    }
  }
  return layers
}

export function RouteChips({
  provenance
}: {
  provenance: readonly string[] | undefined
}) {
  const layers = routeLayers(provenance)
  if (layers.length === 0) return null
  return (
    <span
      className="evidence-route"
      title={(provenance ?? []).join('\n→ ')}
      aria-label={`근거 경로: ${layers.join(', ')}`}
    >
      {layers.map((layer, index) => (
        <React.Fragment key={layer}>
          {index > 0 ? (
            <span className="evidence-route__arrow" aria-hidden="true">
              →
            </span>
          ) : null}
          <span className="evidence-route__chip">{layer}</span>
        </React.Fragment>
      ))}
    </span>
  )
}

/** The ordered steps that built this answer's evidence, one per knowledge layer, with what each one handed on. */
export default function EvidenceChain({
  stages
}: {
  stages: readonly LegalChainStage[] | undefined
}) {
  if (!stages?.length) return null
  return (
    <ol className="evidence-chain" aria-label="근거 형성 과정">
      {stages.map((stage, index) => (
        <li
          key={`${stage.id}-${index}`}
          className={`evidence-chain__stage evidence-chain__stage--${stage.id}`}
        >
          <span className="evidence-chain__marker" aria-hidden="true">
            {index + 1}
          </span>
          <div className="evidence-chain__body">
            <strong>{stage.label}</strong>
            <p>{stage.summary}</p>
            {stage.items.length > 0 ? (
              <details>
                <summary>세부 {stage.items.length}건</summary>
                <ul>
                  {stage.items.map((item, itemIndex) => (
                    <li key={`${item}-${itemIndex}`}>{item}</li>
                  ))}
                </ul>
              </details>
            ) : null}
          </div>
        </li>
      ))}
    </ol>
  )
}
