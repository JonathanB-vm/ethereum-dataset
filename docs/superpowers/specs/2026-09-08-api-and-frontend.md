# API and explorer changes for server-side data

Date: 2026-09-08
Status: draft, pending user approval
Parent: `2026-09-08-scale-to-one-year-architecture.md`

## What changes in the explorer

The UI keeps its design, table, filters, chips, dictionary panel and export menu. What
changes is where the work happens: the browser stops loading the dataset and starts asking
for pages. Concretely:

| Today (client-side) | After |
|---|---|
| `DataProvider.load()` returns every record | `DataProvider.query(request)` returns one page + cursor |
| TanStack sorts/filters/paginates in memory | `manualPagination`, `manualSorting`, `manualFiltering`; the API does the work |
| Stats band computed from loaded records | `DataProvider.stats(scope)` reads materialized aggregates |
| Dictionary per-column stats computed in the browser | served from the nightly `column_stats` table |
| Export builds the CSV in the browser | export is a server stream or an async job |
| Block badge = max block in the CSV | block picker + range; badge shows "current to block N" |
| Global search matches any substring in any field | typed lookup: 66-char hex → tx hash, 42-char hex → address, digits → block number, else a filter on the current view |

The CSV provider survives as an in-memory implementation of the new interface for tests
and offline demos.

### Provider interface

```ts
interface QueryRequest {
  view: 'transfers' | 'transactions' | 'all'   // 'all' = query-time join, block range required
  scope: { blockFrom: number; blockTo: number } | { address: Hex } | { txHash: Hex }
  filters: ColumnFilter[]                       // same shapes as today's filters.ts
  sort: { field: string; dir: 'asc' | 'desc' } | null
  cursor: string | null
  limit: number                                  // ≤ 1000
}
interface Page<T> { rows: T[]; nextCursor: string | null; total?: number /* exact if cheap, else omitted */ }

interface DataProvider {
  query(req: QueryRequest): Promise<Page<EthRecord>>
  stats(scope: QueryRequest['scope']): Promise<DatasetStats>
  columnStats(): Promise<ColumnStats[]>
  head(): Promise<{ block: number; timestamp: string }>
}
```

Every query is bounded: a block range (max 100,000 blocks per page request), an address,
or a hash. "Everything" is not a valid scope; the default view on load is the latest 100
blocks.

## API

REST, JSON, versioned under `/v1`. All hex fields are `0x`-prefixed lowercase strings;
256-bit numbers are decimal strings (as today).

| Endpoint | Purpose |
|---|---|
| `GET /v1/head` | latest ingested block, timestamp, dataset release |
| `GET /v1/blocks/{n}` | block summary and counts |
| `GET /v1/blocks/{n}/transactions`, `/transfers` | pages within one block |
| `GET /v1/transactions?block_from&block_to&from&to&type&cursor&limit&sort` | filtered page |
| `GET /v1/transfers?block_from&block_to&token&from&to&event_type&cursor&limit&sort` | filtered page |
| `GET /v1/records?block_from&block_to&…` | the flat 35-column join ("All Records") for a bounded range |
| `GET /v1/transactions/{hash}?include=transfers` | one transaction, optionally with its transfers |
| `GET /v1/addresses/{addr}/transactions`, `/transfers` | via the address index tables |
| `GET /v1/stats?block_from&block_to` and `/v1/stats/daily?from&to` | materialized aggregates |
| `GET /v1/columns/stats` | dictionary panel stats |
| `GET /v1/export.csv?…` | synchronous streaming export, ≤ 100,000 rows |
| `POST /v1/exports` → `GET /v1/exports/{id}` | async export ≤ 5 M rows, CSV or Parquet, result is a time-limited R2 link |
| `GET /v1/dataset/manifest` | the Parquet manifest for the downloads page |
| (M2 option) read-only SQL endpoint | a ClickHouse user with CryptoHouse-style limits (`max_execution_time 60`, `max_result_rows 1000`, 60 queries/hour) for researchers who want raw SQL |

### Pagination

Cursor = opaque base64 of the sort key of the last row `(block_number, transaction_index,
event_index, batch_index)`, plus the sort direction. The next page is `WHERE key > cursor
ORDER BY key LIMIT n`, which costs the same on page 10,000 as on page 1. `OFFSET` is not
supported. Sorting by a non-key column (e.g. value) is allowed within a block range only,
and the cursor then carries `(sort value, key)`.

### Limits and safety

- `limit` ≤ 1000 for anonymous, ≤ 10,000 with an API key (Etherscan's free/paid split and
  CryptoHouse's 1,000-row cap are the same brackets). Rate limit 300 req/min per IP
  anonymous (Blockscout's default), 600 with a key; responses carry `x-ratelimit-limit`
  and `x-ratelimit-remaining`. Async exports: 10 jobs per hour per key.
- ClickHouse per-query settings from the API user: `max_execution_time = 30`,
  `max_rows_to_read` sized to a 100,000-block range, `max_memory_usage` 4 GB.
- Unbounded requests return 400 with a message naming the required scope.
- Read-only ClickHouse user; the API never interpolates strings into SQL (parameterized
  queries only).

### Caching

Block data is immutable once finalized, so:

- Responses whose `block_to` ≤ head − 100: `Cache-Control: public, max-age=31536000, immutable`
  and a strong `ETag`. Cloudflare caches them indefinitely.
- Responses touching the latest 100 blocks or `/v1/head`: `max-age=15`.
- Exports: not cached; async results live in R2 for 7 days.

### Implementation choice

Recommendation: **TypeScript** (Fastify + `@clickhouse/client`), so `EthRecord`, the filter
shapes and the dictionary in `src/data/` are shared with the explorer instead of duplicated.
The ingest job stays Python (its tooling is better there); the two never share code, only
the Parquet contract. If the team prefers one language, Python FastAPI is a fine API too;
the cost is a hand-maintained copy of the types.

Deployment: the API and the built explorer run as two containers next to ClickHouse on
the same server, behind Caddy (TLS) and Cloudflare (CDN, rate limiting).

## Downloads page (new in the explorer)

A page listing the manifest: per month, per table, file size, block range, row count,
sha256, a direct R2 link, and a copy-paste snippet:

```sql
-- DuckDB, no download needed: reads only the row groups the query touches
SELECT block_number, from_address, to_address, quantity
FROM read_parquet('https://<r2-host>/v1/token_transfers/year=2026/month=07/*.parquet')
WHERE address = '0xdac17f958d2ee523a2206206994597c13d831ec7';
```

plus pandas/pyarrow equivalents, the schema JSON, the release tag and citation text.

## Explorer tasks affected (for the roadmap)

- `src/data/provider.ts`, `csvProvider.ts`: new interface; `apiProvider.ts` added.
- `src/features/table/DataTable.tsx`, `filters.ts`: manual modes; filters serialize to query
  params instead of predicates.
- `src/features/stats/`: read `stats()`; remove `computeStats` from the hot path (keep for the CSV provider).
- `src/features/dictionary/columnStats.ts`: read `columnStats()`.
- `src/features/export/`: call the export endpoints; async job progress UI.
- `src/components/Header.tsx`: block picker/range; typed global search; "current to block N".
- New: downloads page.
- Tests: provider contract tests run against both the CSV provider and a recorded API fixture.
