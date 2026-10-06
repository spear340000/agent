import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { ApiAuthenticator } from "../src/api/authentication.ts";
import { errorResponse } from "../src/api/http.ts";
import { ApiRouter } from "../src/api/router.ts";

let receivedQuery = "";
let receivedGraphQuery = "";
let receivedGraphLimit = 0;
let receivedWikiEntryQuery = "";
const receivedAllQueries: string[] = [];
const record = {
  kind: "law",
  corpus: "law",
  recordId: "law-1",
  title: "민법",
  excerpt: "제750조",
  lawName: "민법",
  articleNumber: "750",
  articleLabel: "제750조(불법행위의 내용)",
};
const graphRecord = {
  kind: "graph",
  corpus: "graph",
  recordId: "edge-1",
  title: "민법#제750조 → 판례",
  excerpt: "관계 근거",
};
const registeredTools = [
  { name: "search_laws", description: "법령 검색" },
  { name: "search_legal_graph", description: "관계 검색" },
];
const router = new ApiRouter({
  authenticator: new ApiAuthenticator(),
  legalRetrieval: {
    searchLaws: async (query: string, limit: number) => {
      if (!query.includes("750")) receivedQuery = query;
      else receivedAllQueries.push(query);
      assert.equal(limit, 20);
      return [record];
    },
    searchPrecedents: async (query: string) => {
      if (query.includes("750")) receivedAllQueries.push(query);
      return query.includes("750")
        ? [{ kind: "precedent", corpus: "precedent", recordId: "case-1", title: "판례", excerpt: "민법 제750조" }]
        : [];
    },
    getPrecedentDocument: async (identifier: string, offset: number) => ({
      record: { kind: "precedent", corpus: "precedent", recordId: identifier, title: "실제 판례", excerpt: `원문 ${offset}` },
      paging: { offset, total: 50, hasMore: offset < 40 },
      pageLength: 10,
    }),
    searchGraph: async (query: string, limit: number) => {
      receivedGraphQuery = query;
      receivedGraphLimit = limit;
      return [graphRecord];
    },
    listTools: async () => registeredTools,
  },
  legalCatalog: {
    list: async () => [{ name: "index.md", content: "# OKF catalog" }],
  },
  legalWiki: {
    list: async () => [],
    readPage: async () => ({ name: "법률.md", content: "", offset: 0, nextOffset: 0, totalCharacters: 0, hasMore: false }),
    listEntries: async (name: string, query: string, offset: number, limit: number) => {
      receivedWikiEntryQuery = query;
      return {
        name,
        query,
        offset,
        limit,
        total: 1,
        hasMore: false,
        items: [{ title: "민법", status: "시행", effectiveDate: "2024-07-03", offset: 10, endOffset: 100, excerpt: "제1조" }],
      };
    },
  },
} as never);
const server = http.createServer((request, response) => {
  void router
    .handle(request, response)
    .catch((error) => errorResponse(response, error));
});
server.listen(0, "127.0.0.1");
await new Promise<void>((resolve) => server.once("listening", resolve));
const address = server.address();
assert.ok(address && typeof address === "object");
const baseUrl = `http://127.0.0.1:${address.port}`;

try {
  const response = await fetch(
    `${baseUrl}/api/legal/library?corpus=law&limit=20&q=${encodeURIComponent("  민법  ")}`,
  );
  assert.equal(response.status, 200);
  const body = (await response.json()) as {
    query: string;
    corpus: string;
    items: { title: string; citationId: string }[];
  };
  assert.equal(
    receivedQuery,
    "  민법  ",
    "the library passes the original query through unchanged",
  );
  assert.equal(body.query, receivedQuery);
  assert.equal(body.items[0]?.title, "민법");
  assert.equal(body.items[0]?.citationId, "L1");

  const graphResponse = await fetch(
    `${baseUrl}/api/legal/library?corpus=graph&limit=5&q=${encodeURIComponent("민법 제750조")}`,
  );
  assert.equal(graphResponse.status, 200);
  const graphBody = (await graphResponse.json()) as {
    items: { corpus: string; citationId: string }[];
  };
  assert.equal(graphBody.items[0]?.corpus, "graph");
  assert.equal(graphBody.items[0]?.citationId, "G1");
  assert.equal(receivedGraphQuery, "민법 제750조");
  assert.equal(receivedGraphLimit, 5);

  const graphMaxResponse = await fetch(
    `${baseUrl}/api/legal/library?corpus=graph&limit=30&q=${encodeURIComponent("민법 제750조")}`,
  );
  assert.equal(graphMaxResponse.status, 200);
  assert.equal(receivedGraphLimit, 30);

  const allResponse = await fetch(
    `${baseUrl}/api/legal/library?corpus=all&q=${encodeURIComponent("  민법 제750조  ")}`,
  );
  assert.equal(allResponse.status, 200);
  const allBody = (await allResponse.json()) as {
    corpus: string;
    items: { corpus: string }[];
  };
  assert.equal(allBody.corpus, "all");
  assert.deepEqual(allBody.items.map((item) => item.corpus), ["law", "precedent"]);
  assert.deepEqual(receivedAllQueries, ["  민법 제750조  ", "  민법 제750조  "]);

  const precedentResponse = await fetch(
    `${baseUrl}/api/legal/precedent?identifier=${encodeURIComponent("2013가합30895")}&offset=12`,
  );
  assert.equal(precedentResponse.status, 200);
  const precedentBody = (await precedentResponse.json()) as {
    item: { title: string; citationId: string };
    paging: { offset: number; total: number; hasMore: boolean };
    nextOffset: number;
  };
  assert.equal(precedentBody.item.title, "실제 판례");
  assert.equal(precedentBody.item.citationId, "P1");
  assert.deepEqual(precedentBody.paging, { offset: 12, total: 50, hasMore: true });
  assert.equal(precedentBody.nextOffset, 22);

  const toolsBody = (await (
    await fetch(`${baseUrl}/api/legal/tools`)
  ).json()) as { items: typeof registeredTools };
  assert.deepEqual(toolsBody.items, registeredTools);
  const catalogBody = (await (
    await fetch(`${baseUrl}/api/legal/catalog`)
  ).json()) as { items: { name: string; content: string }[] };
  assert.equal(catalogBody.items[0]?.name, "index.md");
  assert.match(catalogBody.items[0]?.content ?? "", /OKF catalog/);

  const wikiEntriesResponse = await fetch(
    `${baseUrl}/api/legal/wiki/entries?name=${encodeURIComponent("법률.md")}&q=${encodeURIComponent("민법")}&offset=0&limit=10`,
  );
  assert.equal(wikiEntriesResponse.status, 200);
  const wikiEntriesBody = (await wikiEntriesResponse.json()) as {
    total: number;
    items: { title: string; offset: number; endOffset: number }[];
  };
  assert.equal(receivedWikiEntryQuery, "민법");
  assert.equal(wikiEntriesBody.total, 1);
  assert.equal(wikiEntriesBody.items[0]?.title, "민법");
  assert.equal(wikiEntriesBody.items[0]?.endOffset, 100);

  assert.equal(
    (await fetch(`${baseUrl}/api/legal/library?corpus=unknown&q=test`)).status,
    400,
  );
  assert.equal(
    (await fetch(`${baseUrl}/api/legal/precedent?identifier=x&offset=-1`)).status,
    400,
  );
  assert.equal(
    (
      await fetch(
        `${baseUrl}/api/legal/library?corpus=precedent&limit=11&q=test`,
      )
    ).status,
    400,
  );
  assert.equal(
    (await fetch(`${baseUrl}/api/legal/library?corpus=graph&limit=31&q=test`)).status,
    400,
  );
} finally {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}

test("legal library search returns real corpus records without invoking the model", () => {
  assert.equal(receivedQuery, "  민법  ");
});

console.log("legal library API integration tests passed");
