# Normalized Quantity Column Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a **Normalized Quantity** column immediately right of Quantity on the Token Transfers tab, showing `quantity ÷ 10^decimals` with the token symbol, sourced from a small prep-time token-decimals lookup.

**Architecture:** A standalone script distills `tokens.csv` (39 MB) down to `public/data/tokens.json` (a few KB) containing only the token contracts that actually appear in the dataset. The browser loads that into a `Map`, and the column derives its value per cell with `BigInt`-only math. The row artifact `rows.csv.gz` is not touched — it stays a faithful mirror of the BigQuery export.

**Tech Stack:** TypeScript, React 19, TanStack Table v8, Papaparse, Vitest + Testing Library, Node ESM scripts.

## Global Constraints

- **Never use `Number`/`parseFloat` on a BigQuery numeric string.** These values reach 256 bits. All arithmetic and comparison is `BigInt`. This is the project's standing rule (`transform.ts`, `filters.ts`).
- **Never guess a divisor.** A contract with no known decimals renders `—`. There is no fallback to 18.
- **Both CSVs need a real parser.** `tokens.csv` has commas and quotes inside `name`; `rows.csv.gz` has them inside `event_signature` (e.g. `Transfer(address,address,uint256)`). Naive comma splitting silently corrupts both. Use Papaparse.
- **Valid decimals** = an integer in `0..77` inclusive. Anything else (empty, negative, fractional, larger) is *unknown*.
- **Addresses are lowercased** on both sides of every registry lookup.
- **A missing or malformed `tokens.json` must never fail the dataset load.** It degrades to an empty registry.
- **Column id** is exactly `normalized_quantity`. **Display label** is exactly `Normalized Quantity`.
- **Display format:** thousands separators on the integer part, fractional part truncated (never rounded) to 6 digits with trailing zeros stripped, `<0.000001` for non-zero values below that, faint `0` for true zero.
- **CSV export** of the derived column emits the exact full-precision value — no separators, no symbol.
- Run tests with `npx vitest run <path>`. The full suite is `npm test`. Type-check with `npm run build`.

## Spec addendum (not in the design doc — flag to the user if it is unwanted)

Adding `normalized_quantity` to `COLUMNS` breaks an existing drift test: `RowDetail.test.ts` asserts `GROUPS.flatMap(g => g.fields)` is set-equal to `COLUMNS.map(c => c.field)`. The design doc did not cover the row-detail panel. **Task 4 resolves this by adding the field to the `Token Transfer` group and rendering its derived value in the expanded row detail**, which is the consistent outcome — the alternative (narrowing the drift test so row detail silently omits the column) would make an expanded row disagree with the table above it.

## File Structure

| File | Status | Responsibility |
|---|---|---|
| `src/data/transform.ts` | Modify | Add the three pure normalization functions + `isValidDecimals` |
| `src/data/tokenRegistry.ts` | Create | Registry type, total parser, lookup helper, fetch provider |
| `src/data/tokenRegistry.test.ts` | Create | Parser/provider tests |
| `scripts/tokensPrep.mjs` | Create | Pure, `fs`-free helpers for the artifact build |
| `scripts/tokensPrep.test.mjs` | Create | Tests for those helpers |
| `scripts/prepare-tokens.mjs` | Create | Streaming CLI, `npm run data:tokens` |
| `src/data/dictionary.ts` | Modify | `normalized_quantity` entry, `'derived'` availability |
| `src/features/table/rowDetailFields.ts` | Modify | Add field to the `Token Transfer` group |
| `src/features/table/RowDetail.tsx` | Modify | Render the derived value |
| `src/features/table/RowFullscreen.tsx` | Modify | Thread the registry to its `RowDetail` |
| `src/features/dictionary/DictionaryPanel.tsx` | Modify | `'derived'` branch beside `'on-demand'` |
| `src/features/table/CellRenderers.tsx` | Modify | `NormalizedQuantityCell` |
| `src/features/table/filters.ts` | Modify | `normalizedRangeFilter` (pure) |
| `src/features/table/columns.tsx` | Modify | Column def; `getColumnsForTab(tab, registry)` |
| `src/features/table/DataTable.tsx` | Modify | `tokens` prop, memoized columns |
| `src/App.tsx` | Modify | Load the registry, pass it down |
| `src/features/export/exportCsv.ts` | Modify | Derived-column resolver |
| `src/features/export/ExportButton.tsx` | Modify | Supply the resolver |
| `src/features/table/__fixtures__/tableHarness.tsx` | Modify | Optional registry in the harness |
| `README.md` | Modify | Document the column, the pipeline step, the coverage limit |

---

### Task 1: Normalization math

**Files:**
- Modify: `src/data/transform.ts` (append after `decimalToWei`, before `compareNumericStrings`)
- Test: `src/data/transform.test.ts` (append)

**Interfaces:**
- Consumes: existing `toBigInt(v: string | null): bigint | null` from this same file.
- Produces:
  - `isValidDecimals(d: unknown): d is number`
  - `normalizeQuantity(quantity: string | null, decimals: number): string | null`
  - `formatNormalizedQuantity(quantity: string | null, decimals: number): string | null`
  - `compareNormalizedQuantity(aQty: string | null, aDec: number | null, bQty: string | null, bDec: number | null): number`

- [ ] **Step 1: Write the failing tests**

Append to `src/data/transform.test.ts`. Note the imports at the top of that file need the four new names added.

```ts
describe('isValidDecimals', () => {
  it('accepts integers 0 through 77', () => {
    expect(isValidDecimals(0)).toBe(true)
    expect(isValidDecimals(18)).toBe(true)
    expect(isValidDecimals(77)).toBe(true)
  })

  it('rejects non-integers, negatives, out-of-range and non-numbers', () => {
    expect(isValidDecimals(1.5)).toBe(false)
    expect(isValidDecimals(-1)).toBe(false)
    expect(isValidDecimals(78)).toBe(false)
    expect(isValidDecimals(Number.NaN)).toBe(false)
    expect(isValidDecimals('6')).toBe(false)
    expect(isValidDecimals(null)).toBe(false)
  })
})

describe('normalizeQuantity', () => {
  it('divides by 10^decimals exactly, with no truncation', () => {
    // The worked example from the spec: 80 USDT stored as 80000000 at decimals 6.
    expect(normalizeQuantity('80000000', 6)).toBe('80')
    expect(normalizeQuantity('500000000000000000', 18)).toBe('0.5')
    expect(normalizeQuantity('5', 18)).toBe('0.000000000000000005')
    expect(normalizeQuantity('1234567890123', 6)).toBe('1234567.890123')
  })

  it('returns the integer unchanged at decimals 0', () => {
    expect(normalizeQuantity('42', 0)).toBe('42')
  })

  it('returns "0" for a zero quantity', () => {
    expect(normalizeQuantity('0', 18)).toBe('0')
  })

  it('returns null for a null/blank quantity or invalid decimals', () => {
    expect(normalizeQuantity(null, 6)).toBeNull()
    expect(normalizeQuantity('', 6)).toBeNull()
    expect(normalizeQuantity('80000000', -1)).toBeNull()
    expect(normalizeQuantity('80000000', 1.5)).toBeNull()
  })
})

describe('formatNormalizedQuantity', () => {
  it('formats the spec worked example', () => {
    expect(formatNormalizedQuantity('80000000', 6)).toBe('80')
  })

  it('adds thousands separators to the integer part', () => {
    expect(formatNormalizedQuantity('1500000000', 6)).toBe('1,500')
    expect(formatNormalizedQuantity('1234567890123', 6)).toBe('1,234,567.890123')
  })

  it('truncates the fraction to 6 digits and strips trailing zeros', () => {
    expect(formatNormalizedQuantity('500000000000000000', 18)).toBe('0.5')
    // 1.2345678 at 18 decimals -> truncated, not rounded, to 6 fraction digits.
    expect(formatNormalizedQuantity('1234567800000000000', 18)).toBe('1.234567')
  })

  it('marks non-zero dust below display precision rather than showing 0', () => {
    expect(formatNormalizedQuantity('5', 18)).toBe('<0.000001')
    expect(formatNormalizedQuantity('999999999999', 18)).toBe('<0.000001')
  })

  it('shows a true zero as "0", distinct from dust', () => {
    expect(formatNormalizedQuantity('0', 18)).toBe('0')
  })

  it('returns null for a null quantity or invalid decimals', () => {
    expect(formatNormalizedQuantity(null, 6)).toBeNull()
    expect(formatNormalizedQuantity('80000000', 78)).toBeNull()
  })
})

describe('compareNormalizedQuantity', () => {
  it('orders correctly across different decimal scales', () => {
    // 0.5 WETH (18 dp) vs 80 USDT (6 dp) — 0.5 is the smaller normalized value even
    // though its raw integer (5e17) is far larger than 80000000.
    expect(compareNormalizedQuantity('500000000000000000', 18, '80000000', 6)).toBeLessThan(0)
    expect(compareNormalizedQuantity('80000000', 6, '500000000000000000', 18)).toBeGreaterThan(0)
  })

  it('returns 0 for equal normalized values at different scales', () => {
    // 1 token at 6 dp vs 1 token at 18 dp.
    expect(compareNormalizedQuantity('1000000', 6, '1000000000000000000', 18)).toBe(0)
  })

  it('sorts unknown decimals and null quantities last', () => {
    expect(compareNormalizedQuantity('1', 6, '1', null)).toBeLessThan(0)
    expect(compareNormalizedQuantity('1', null, '1', 6)).toBeGreaterThan(0)
    expect(compareNormalizedQuantity(null, 6, '1', 6)).toBeGreaterThan(0)
    expect(compareNormalizedQuantity(null, null, null, null)).toBe(0)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/data/transform.test.ts`
Expected: FAIL — `isValidDecimals is not defined` (and the other three names).

- [ ] **Step 3: Write the implementation**

Append to `src/data/transform.ts`:

```ts
/** Fraction digits shown in the table. Beyond this, a value is truncated — never rounded. */
const NORMALIZED_DISPLAY_DIGITS = 6

/**
 * A token's `decimals` is only usable if it is a plain integer in 0..77 — 77 is the most
 * base-10 digits a 256-bit unsigned integer can carry, so anything larger could not describe
 * a real on-chain quantity. Everything else (empty, negative, fractional, non-numeric) is
 * "unknown", which the UI renders as a dash rather than guessing a divisor.
 */
export function isValidDecimals(d: unknown): d is number {
  return typeof d === 'number' && Number.isInteger(d) && d >= 0 && d <= 77
}

/** Splits |quantity| into its whole part and its zero-padded fractional digits. */
function splitScaled(quantity: string | null, decimals: number) {
  if (!isValidDecimals(decimals)) return null
  const raw = toBigInt(quantity)
  if (raw == null) return null
  const negative = raw < 0n
  const abs = negative ? -raw : raw
  const divisor = 10n ** BigInt(decimals)
  return {
    negative,
    isZero: abs === 0n,
    whole: abs / divisor,
    // padStart to `decimals` so 5 at 18 dp yields "000000000000000005", not "5".
    frac: decimals === 0 ? '' : (abs % divisor).toString().padStart(decimals, '0'),
  }
}

/**
 * `quantity ÷ 10^decimals` as an exact decimal string — every digit, no truncation. This is
 * the lossless form: it is what the CSV export writes, so a normalized value round-trips
 * with the same fidelity as the raw columns. `formatNormalizedQuantity` is the display form.
 */
export function normalizeQuantity(quantity: string | null, decimals: number): string | null {
  const parts = splitScaled(quantity, decimals)
  if (parts == null) return null
  const frac = parts.frac.replace(/0+$/, '')
  const body = frac === '' ? parts.whole.toString() : `${parts.whole}.${frac}`
  return parts.negative ? `-${body}` : body
}

/**
 * Display form: thousands separators on the whole part (matching `BigNumCell`, the Quantity
 * column this sits beside) and at most 6 fraction digits.
 *
 * The `<0.000001` case is the reason this isn't just `normalizeQuantity` truncated: an
 * 18-decimal token's dust would otherwise render as a bare "0", indistinguishable from a
 * genuine zero-value transfer. Truncating to a marker keeps "something small moved" and
 * "nothing moved" visually distinct.
 */
export function formatNormalizedQuantity(
  quantity: string | null,
  decimals: number,
): string | null {
  const parts = splitScaled(quantity, decimals)
  if (parts == null) return null

  const frac = parts.frac.slice(0, NORMALIZED_DISPLAY_DIGITS).replace(/0+$/, '')
  const whole = parts.whole.toLocaleString('en-US')

  let body: string
  if (frac !== '') {
    body = `${whole}.${frac}`
  } else if (!parts.isZero && parts.whole === 0n) {
    // Non-zero, but every significant digit sits past the display precision.
    return `${parts.negative ? '>-' : '<'}0.${'0'.repeat(NORMALIZED_DISPLAY_DIGITS - 1)}1`
  } else {
    body = whole
  }
  return parts.negative ? `-${body}` : body
}

/**
 * Compares two normalized quantities that may be on *different* scales — the whole point of
 * sorting this column, since each row's divisor comes from its own token contract.
 *
 * Compares `a / 10^da` against `b / 10^db` by cross-multiplication (`a·10^db` vs `b·10^da`),
 * which is exact in `BigInt` and needs no division. Doing this in floating point would
 * misorder values near the top of the 256-bit range. Nulls and unknown decimals sort last,
 * matching `compareNumericStrings`.
 */
export function compareNormalizedQuantity(
  aQty: string | null,
  aDec: number | null,
  bQty: string | null,
  bDec: number | null,
): number {
  const a = isValidDecimals(aDec) ? toBigInt(aQty) : null
  const b = isValidDecimals(bDec) ? toBigInt(bQty) : null
  if (a == null && b == null) return 0
  if (a == null) return 1
  if (b == null) return -1
  const left = a * 10n ** BigInt(bDec as number)
  const right = b * 10n ** BigInt(aDec as number)
  return left < right ? -1 : left > right ? 1 : 0
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/data/transform.test.ts`
Expected: PASS, including the pre-existing tests in that file.

- [ ] **Step 5: Commit**

```bash
git add src/data/transform.ts src/data/transform.test.ts
git commit -m "feat: BigInt-exact token quantity normalization helpers"
```

---

### Task 2: Token registry module

**Files:**
- Create: `src/data/tokenRegistry.ts`
- Test: `src/data/tokenRegistry.test.ts`

**Interfaces:**
- Consumes: `isValidDecimals` from `./transform` (Task 1).
- Produces:
  - `interface TokenInfo { symbol: string | null; decimals: number }`
  - `type TokenRegistry = Map<string, TokenInfo>`
  - `const EMPTY_TOKEN_REGISTRY: TokenRegistry`
  - `parseTokenRegistry(json: unknown): TokenRegistry`
  - `lookupToken(registry: TokenRegistry, address: string | null): TokenInfo | null`
  - `tokenDecimals(registry: TokenRegistry, address: string | null): number | null`
  - `tokenRegistryProvider(url?: string): { load(): Promise<TokenRegistry> }`

- [ ] **Step 1: Write the failing tests**

Create `src/data/tokenRegistry.test.ts`:

```ts
import { describe, expect, it, vi, afterEach } from 'vitest'
import {
  parseTokenRegistry,
  lookupToken,
  tokenDecimals,
  tokenRegistryProvider,
} from './tokenRegistry'

const PAYLOAD = {
  contractsInDataset: 3,
  contractsWithDecimals: 2,
  tokens: {
    '0xdac17f958d2ee523a2206206994597c13d831ec7': { symbol: 'USDT', decimals: 6 },
    '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2': { symbol: 'WETH', decimals: 18 },
  },
}

describe('parseTokenRegistry', () => {
  it('reads entries into a Map keyed by address', () => {
    const reg = parseTokenRegistry(PAYLOAD)
    expect(reg.size).toBe(2)
    expect(reg.get('0xdac17f958d2ee523a2206206994597c13d831ec7')).toEqual({
      symbol: 'USDT',
      decimals: 6,
    })
  })

  it('lowercases addresses so lookups are case-insensitive', () => {
    const reg = parseTokenRegistry({
      tokens: { '0xDAC17F958D2EE523A2206206994597C13D831EC7': { symbol: 'USDT', decimals: 6 } },
    })
    expect(reg.get('0xdac17f958d2ee523a2206206994597c13d831ec7')?.decimals).toBe(6)
  })

  it('skips individual malformed entries without discarding the rest', () => {
    const reg = parseTokenRegistry({
      tokens: {
        '0xgood': { symbol: 'OK', decimals: 6 },
        '0xbad1': { symbol: 'NO', decimals: -1 },
        '0xbad2': { symbol: 'NO', decimals: 'six' },
        '0xbad3': { symbol: 'NO' },
        '0xbad4': null,
      },
    })
    expect(reg.size).toBe(1)
    expect(reg.get('0xgood')?.decimals).toBe(6)
  })

  it('tolerates a missing symbol by storing null', () => {
    const reg = parseTokenRegistry({ tokens: { '0xa': { decimals: 8 } } })
    expect(reg.get('0xa')).toEqual({ symbol: null, decimals: 8 })
  })

  it('returns an empty registry for any unrecognised shape', () => {
    expect(parseTokenRegistry(null).size).toBe(0)
    expect(parseTokenRegistry('nope').size).toBe(0)
    expect(parseTokenRegistry({}).size).toBe(0)
    expect(parseTokenRegistry({ tokens: [] }).size).toBe(0)
  })
})

describe('lookupToken / tokenDecimals', () => {
  const reg = parseTokenRegistry(PAYLOAD)

  it('finds a token regardless of the queried address casing', () => {
    expect(lookupToken(reg, '0xDAC17F958D2EE523A2206206994597C13D831EC7')?.symbol).toBe('USDT')
    expect(tokenDecimals(reg, '0xdac17f958d2ee523a2206206994597c13d831ec7')).toBe(6)
  })

  it('returns null for an unknown or null address', () => {
    // USDC is genuinely absent from the real tokens.csv — this is the common case.
    expect(lookupToken(reg, '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48')).toBeNull()
    expect(tokenDecimals(reg, null)).toBeNull()
  })
})

describe('tokenRegistryProvider', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('loads and parses the artifact', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, json: async () => PAYLOAD }),
    )
    const reg = await tokenRegistryProvider('/data/tokens.json').load()
    expect(reg.size).toBe(2)
  })

  it('resolves to an empty registry on a 404 rather than throwing', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 404 }))
    await expect(tokenRegistryProvider().load()).resolves.toEqual(new Map())
  })

  it('resolves to an empty registry when the network or JSON parse fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')))
    await expect(tokenRegistryProvider().load()).resolves.toEqual(new Map())
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/data/tokenRegistry.test.ts`
Expected: FAIL — cannot resolve `./tokenRegistry`.

- [ ] **Step 3: Write the implementation**

Create `src/data/tokenRegistry.ts`:

```ts
import { isValidDecimals } from './transform'

/** What the lookup knows about one token contract. `symbol` is display-only. */
export interface TokenInfo {
  symbol: string | null
  /** Always a valid 0..77 integer — `parseTokenRegistry` drops entries that aren't. */
  decimals: number
}

/** Token contract address (lowercased) → its metadata. */
export type TokenRegistry = Map<string, TokenInfo>

export const EMPTY_TOKEN_REGISTRY: TokenRegistry = new Map()

/**
 * Total parser for `public/data/tokens.json` — it never throws and never rejects a whole
 * payload over one bad row. A malformed entry is skipped; an unrecognisable payload yields
 * an empty registry. The column degrades to dashes either way, which is the designed
 * behavior: the app must stay fully usable without this artifact.
 */
export function parseTokenRegistry(json: unknown): TokenRegistry {
  const registry: TokenRegistry = new Map()
  if (typeof json !== 'object' || json === null) return registry
  const tokens = (json as { tokens?: unknown }).tokens
  // Arrays are objects too, and an array here means the artifact shape changed — reject it
  // rather than silently reading numeric indices as addresses.
  if (typeof tokens !== 'object' || tokens === null || Array.isArray(tokens)) return registry

  for (const [address, value] of Object.entries(tokens as Record<string, unknown>)) {
    if (typeof value !== 'object' || value === null) continue
    const { symbol, decimals } = value as { symbol?: unknown; decimals?: unknown }
    if (!isValidDecimals(decimals)) continue
    registry.set(address.toLowerCase(), {
      symbol: typeof symbol === 'string' && symbol !== '' ? symbol : null,
      decimals,
    })
  }
  return registry
}

export function lookupToken(registry: TokenRegistry, address: string | null): TokenInfo | null {
  if (address == null || address === '') return null
  return registry.get(address.toLowerCase()) ?? null
}

/** Convenience for the sort/filter paths, which only need the divisor exponent. */
export function tokenDecimals(registry: TokenRegistry, address: string | null): number | null {
  return lookupToken(registry, address)?.decimals ?? null
}

/**
 * Fetches the decimals artifact. Every failure path — missing file, non-OK status, network
 * error, unparseable JSON — resolves to an empty registry instead of rejecting, so
 * `App.tsx` can load it without the dataset's own load ever depending on it.
 */
export function tokenRegistryProvider(url = '/data/tokens.json') {
  return {
    async load(): Promise<TokenRegistry> {
      try {
        const res = await fetch(url)
        if (!res.ok) return EMPTY_TOKEN_REGISTRY
        return parseTokenRegistry(await res.json())
      } catch {
        return EMPTY_TOKEN_REGISTRY
      }
    },
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/data/tokenRegistry.test.ts`
Expected: PASS (14 assertions across 11 tests).

- [ ] **Step 5: Commit**

```bash
git add src/data/tokenRegistry.ts src/data/tokenRegistry.test.ts
git commit -m "feat: token decimals registry with total, non-throwing parser"
```

---

### Task 3: Build the `tokens.json` artifact

**Files:**
- Create: `scripts/tokensPrep.mjs`
- Create: `scripts/prepare-tokens.mjs`
- Test: `scripts/tokensPrep.test.mjs`
- Modify: `package.json` (scripts block)
- Modify: `.gitignore`

**Interfaces:**
- Consumes: nothing from earlier tasks (scripts are standalone ESM, deliberately free of `src/`).
- Produces: `public/data/tokens.json`, whose shape Task 2's `parseTokenRegistry` reads.
  - `parseTokenDecimals(raw: unknown): number | null`
  - `buildTokensArtifact(datasetAddresses: Set<string>, tokenRows: Iterable<object>): object`

- [ ] **Step 1: Write the failing tests**

Create `scripts/tokensPrep.test.mjs`:

```js
import { describe, expect, it } from 'vitest'
import { parseTokenDecimals, buildTokensArtifact } from './tokensPrep.mjs'

describe('parseTokenDecimals', () => {
  it('accepts integer strings in range', () => {
    expect(parseTokenDecimals('6')).toBe(6)
    expect(parseTokenDecimals('18')).toBe(18)
    expect(parseTokenDecimals(' 0 ')).toBe(0)
    expect(parseTokenDecimals('77')).toBe(77)
  })

  it('rejects empty, non-numeric, negative, fractional and out-of-range values', () => {
    // Empty decimals is the common case for NFTs in the real tokens.csv.
    expect(parseTokenDecimals('')).toBeNull()
    expect(parseTokenDecimals(undefined)).toBeNull()
    expect(parseTokenDecimals('abc')).toBeNull()
    expect(parseTokenDecimals('-1')).toBeNull()
    expect(parseTokenDecimals('1.5')).toBeNull()
    expect(parseTokenDecimals('78')).toBeNull()
  })
})

describe('buildTokensArtifact', () => {
  const addresses = new Set(['0xusdt', '0xweth', '0xusdc'])

  it('keeps only contracts present in the dataset', () => {
    const out = buildTokensArtifact(addresses, [
      { address: '0xusdt', symbol: 'USDT', decimals: '6' },
      { address: '0xnotinthedataset', symbol: 'XXX', decimals: '18' },
    ])
    expect(Object.keys(out.tokens)).toEqual(['0xusdt'])
  })

  it('drops rows whose decimals are unusable', () => {
    const out = buildTokensArtifact(addresses, [
      { address: '0xusdt', symbol: 'USDT', decimals: '6' },
      { address: '0xweth', symbol: 'NFT', decimals: '' },
    ])
    expect(out.tokens).toEqual({ '0xusdt': { symbol: 'USDT', decimals: 6 } })
  })

  it('lowercases addresses on both sides of the match', () => {
    const out = buildTokensArtifact(new Set(['0xusdt']), [
      { address: '0xUSDT', symbol: 'USDT', decimals: '6' },
    ])
    expect(out.tokens['0xusdt'].decimals).toBe(6)
  })

  it('reports coverage counts', () => {
    const out = buildTokensArtifact(addresses, [
      { address: '0xusdt', symbol: 'USDT', decimals: '6' },
      { address: '0xweth', symbol: 'WETH', decimals: '18' },
    ])
    // USDC is in the dataset but absent from the token rows — exactly the real-world gap.
    expect(out.contractsInDataset).toBe(3)
    expect(out.contractsWithDecimals).toBe(2)
  })

  it('takes the last row when a contract repeats', () => {
    const out = buildTokensArtifact(new Set(['0xa']), [
      { address: '0xa', symbol: 'OLD', decimals: '6' },
      { address: '0xa', symbol: 'NEW', decimals: '8' },
    ])
    expect(out.tokens['0xa']).toEqual({ symbol: 'NEW', decimals: 8 })
  })

  it('stores a null symbol when the source has none', () => {
    const out = buildTokensArtifact(new Set(['0xa']), [{ address: '0xa', decimals: '2' }])
    expect(out.tokens['0xa']).toEqual({ symbol: null, decimals: 2 })
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run scripts/tokensPrep.test.mjs`
Expected: FAIL — cannot resolve `./tokensPrep.mjs`.

- [ ] **Step 3: Write the pure helpers**

Create `scripts/tokensPrep.mjs`:

```js
/**
 * Pure helpers shared by `prepare-tokens.mjs` and its tests. Kept free of `fs` so every rule
 * about what reaches the browser is unit-testable without touching the 39 MB tokens export —
 * same split as `datasetPrep.mjs` / `prepare-dataset.mjs`.
 */

/** Widest base-10 decimals a 256-bit unsigned quantity could meaningfully use. */
const MAX_DECIMALS = 77

/**
 * A token's `decimals` from the CSV, or null if unusable. Null is the common case, not an
 * error: NFT contracts (ERC-721/ERC-1155) legitimately carry no decimals, and their
 * quantities are counts rather than divisible amounts.
 */
export function parseTokenDecimals(raw) {
  const s = String(raw ?? '').trim()
  if (s === '' || !/^\d+$/.test(s)) return null
  const n = Number.parseInt(s, 10)
  return n >= 0 && n <= MAX_DECIMALS ? n : null
}

/**
 * Distills the token export down to the contracts this dataset actually references, keeping
 * only those with usable decimals. `datasetAddresses` must already be lowercased.
 *
 * The two counts are emitted so the UI can state its own coverage instead of hard-coding a
 * number that would rot the moment a wider export lands.
 */
export function buildTokensArtifact(datasetAddresses, tokenRows) {
  const tokens = {}
  for (const row of tokenRows) {
    const address = String(row.address ?? '').trim().toLowerCase()
    if (address === '' || !datasetAddresses.has(address)) continue
    const decimals = parseTokenDecimals(row.decimals)
    if (decimals === null) continue
    const symbol = String(row.symbol ?? '').trim()
    // Last row wins. Measured against the real tokens.csv this is a no-op: its only repeated
    // contract carries identical decimals on every row.
    tokens[address] = { symbol: symbol === '' ? null : symbol, decimals }
  }
  return {
    contractsInDataset: datasetAddresses.size,
    contractsWithDecimals: Object.keys(tokens).length,
    tokens,
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run scripts/tokensPrep.test.mjs`
Expected: PASS (10 tests).

- [ ] **Step 5: Write the streaming CLI**

Create `scripts/prepare-tokens.mjs`:

```js
/**
 * Distills a BigQuery token-contract export down to the decimals lookup the browser loads.
 *
 *   node scripts/prepare-tokens.mjs <tokens.csv> [--rows <rows.csv.gz>] [--out <dir>]
 *
 * Writes `<dir>/tokens.json`: only the token contracts that appear in the shipped dataset,
 * and only those with usable decimals.
 *
 * Deliberately independent of `prepare-dataset.mjs`: it reads the already-built
 * `rows.csv.gz`, not the 2.19 GB source export, so refreshing token metadata is a
 * seconds-long job. Both inputs are streamed and parsed with Papaparse — `tokens.csv` has
 * commas and quotes inside `name`, and `rows.csv.gz` has them inside `event_signature`
 * (e.g. `Transfer(address,address,uint256)`), so neither can be split on commas.
 */
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import zlib from 'node:zlib'
import Papa from 'papaparse'
import { buildTokensArtifact } from './tokensPrep.mjs'

function parseArgs(argv) {
  const source = argv[2]
  const flag = (name, fallback) => {
    const i = argv.indexOf(name)
    if (i === -1) return fallback
    const value = argv[i + 1]
    if (value === undefined) {
      console.error(`usage: node scripts/prepare-tokens.mjs <tokens.csv> [--rows <rows.csv.gz>] [--out <dir>]`)
      process.exit(1)
    }
    return value
  }
  if (!source || source.startsWith('--')) {
    console.error('usage: node scripts/prepare-tokens.mjs <tokens.csv> [--rows <rows.csv.gz>] [--out <dir>]')
    process.exit(1)
  }
  const out = flag('--out', path.join(process.cwd(), 'public', 'data'))
  return { source, rows: flag('--rows', path.join(out, 'rows.csv.gz')), out }
}

/** Streams the shipped row artifact, collecting every distinct token-contract address. */
function readDatasetAddresses(rowsPath) {
  const addresses = new Set()
  return new Promise((resolve, reject) => {
    Papa.parse(fs.createReadStream(rowsPath).pipe(zlib.createGunzip()), {
      header: true,
      skipEmptyLines: 'greedy',
      step: (result) => {
        const address = String(result.data.address ?? '').trim().toLowerCase()
        if (address !== '') addresses.add(address)
      },
      complete: () => resolve(addresses),
      error: reject,
    })
  })
}

/** Streams the token export, keeping only rows whose contract is in `addresses`. */
function readTokenRows(sourcePath, addresses) {
  const kept = []
  return new Promise((resolve, reject) => {
    Papa.parse(fs.createReadStream(sourcePath, { encoding: 'utf8' }), {
      header: true,
      skipEmptyLines: 'greedy',
      step: (result) => {
        const row = result.data
        const address = String(row.address ?? '').trim().toLowerCase()
        // Filter during the stream: the export is ~224k rows and only a few hundred can
        // ever match, so there is no reason to hold the rest.
        if (addresses.has(address)) kept.push(row)
      },
      complete: () => resolve(kept),
      error: reject,
    })
  })
}

async function main() {
  const { source, rows, out } = parseArgs(process.argv)

  console.log(`Reading token contracts from ${rows}…`)
  const addresses = await readDatasetAddresses(rows)
  console.log(`  ${addresses.size.toLocaleString('en-US')} distinct token contracts in the dataset`)

  console.log(`Reading token metadata from ${source}…`)
  const tokenRows = await readTokenRows(source, addresses)
  const artifact = buildTokensArtifact(addresses, tokenRows)

  await fsp.mkdir(out, { recursive: true })
  const target = path.join(out, 'tokens.json')
  await fsp.writeFile(target, `${JSON.stringify(artifact, null, 2)}\n`, 'utf8')

  const { contractsInDataset, contractsWithDecimals } = artifact
  const pct = ((contractsWithDecimals / contractsInDataset) * 100).toFixed(1)
  console.log(`Wrote ${target}`)
  console.log(`  ${contractsWithDecimals} of ${contractsInDataset} contracts have usable decimals (${pct}%)`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
```

- [ ] **Step 6: Wire the npm script and ignore the raw export**

In `package.json`, add to `"scripts"` directly after the `data:prep` line:

```json
    "data:tokens": "node scripts/prepare-tokens.mjs tokens.csv",
```

Append to `.gitignore` (the 39 MB raw export is an input, like the 2.19 GB row export — only the derived `tokens.json` is committed):

```
tokens.csv
```

- [ ] **Step 7: Generate the real artifact and verify the measured numbers**

Run: `npm run data:tokens`
Expected output includes:

```
  955 distinct token contracts in the dataset
  64 of 955 contracts have usable decimals (6.7%)
```

Then confirm the worked example landed:

Run: `node -e "const t=require('./public/data/tokens.json').tokens;console.log(t['0xdac17f958d2ee523a2206206994597c13d831ec7'])"`
Expected: `{ symbol: 'USDT', decimals: 6 }`

If the contract count is not 955 or USDT is missing, stop — the inputs are not the ones this plan was measured against.

- [ ] **Step 8: Commit**

```bash
git add scripts/tokensPrep.mjs scripts/tokensPrep.test.mjs scripts/prepare-tokens.mjs package.json .gitignore public/data/tokens.json
git commit -m "feat: token decimals artifact + data:tokens prep script"
```

---

### Task 4: Dictionary entry and row detail

**Files:**
- Modify: `src/data/dictionary.ts`
- Modify: `src/features/table/rowDetailFields.ts:36-39`
- Modify: `src/features/table/RowDetail.tsx`
- Modify: `src/features/dictionary/DictionaryPanel.tsx:305`, `:397-408`
- Test: `src/data/dictionary.test.ts` (append)

**Interfaces:**
- Consumes: `formatNormalizedQuantity` (Task 1); `TokenRegistry`, `lookupToken` (Task 2).
- Produces: `DictionaryField` widened to include `'normalized_quantity'`; `ColumnMeta['availability']` widened with `'derived'`; `RowDetail` gains a required `tokens: TokenRegistry` prop.

- [ ] **Step 1: Update the four existing dictionary tests the new entry invalidates**

`src/data/dictionary.test.ts` hard-codes today's counts and availability values. Adding a
36th entry after `quantity` (index 16) shifts everything below it, so these are **expected**
failures to be updated, not regressions to be worked around.

Rename and update the first test:

```ts
  it('documents all 36 fields — 35 dataset columns in CSV order, plus one derived', () => {
    expect(COLUMNS).toHaveLength(36)
    expect(COLUMNS[0].field).toBe('block_hash')
    expect(COLUMNS[35].field).toBe('is_token_transfer')
  })
```

Widen the availability test:

```ts
  it('every column declares a valid availability', () => {
    for (const c of COLUMNS) {
      expect(['loaded', 'on-demand', 'derived']).toContain(c.availability)
    }
  })
```

Fix the `LOADED_COLUMNS` equality assertion, which currently assumes `input_tx` is the only
non-loaded field:

```ts
  it('LOADED_COLUMNS is the 34 in-memory columns, in CSV order, without input_tx', () => {
    expect(LOADED_COLUMNS).toHaveLength(34)
    expect(LOADED_COLUMNS.map((c) => c.field)).not.toContain('input_tx')
    expect(LOADED_COLUMNS.every((c) => c.availability === 'loaded')).toBe(true)
    expect(LOADED_COLUMNS.map((c) => c.field)).toEqual(
      COLUMNS.filter((c) => c.availability === 'loaded').map((c) => c.field),
    )
  })
```

Add a companion to the existing on-demand test:

```ts
  it('marks exactly one field as derived, and it is normalized_quantity', () => {
    const derived = COLUMNS.filter((c) => c.availability === 'derived')
    expect(derived).toHaveLength(1)
    expect(derived[0].field).toBe('normalized_quantity')
  })
```

The `marks exactly one field as on-demand` and `every column has a non-empty description and
a source` tests need no change — `'derived'` is already an accepted `source` value.

- [ ] **Step 2: Write the failing tests for the new entry**

Append to `src/data/dictionary.test.ts`:

```ts
describe('normalized_quantity dictionary entry', () => {
  it('is documented as a derived column', () => {
    const meta = getColumnMeta('normalized_quantity')
    expect(meta).toBeDefined()
    expect(meta?.label).toBe('Normalized Quantity')
    expect(meta?.source).toBe('derived')
    expect(meta?.availability).toBe('derived')
    expect(meta?.kind).toBe('bignum')
  })

  it('stays out of LOADED_COLUMNS, which must only hold real EthRecord fields', () => {
    // LOADED_COLUMNS drives global search, column stats and the all-columns export — all of
    // which read record[field]. A derived field has no value to read.
    expect(LOADED_COLUMNS.map((c) => c.field)).not.toContain('normalized_quantity')
    expect(LOADED_COLUMNS).toHaveLength(34)
  })

  it('sits immediately after quantity in COLUMNS order', () => {
    const fields = COLUMNS.map((c) => c.field)
    expect(fields[fields.indexOf('quantity') + 1]).toBe('normalized_quantity')
  })
})
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx vitest run src/data/dictionary.test.ts src/features/table/RowDetail.test.ts`
Expected: FAIL — `getColumnMeta('normalized_quantity')` is undefined, `COLUMNS` has 35 entries not 36, and `RowDetail.test.ts`'s drift test now sees a length mismatch.

- [ ] **Step 4: Add the dictionary entry**

In `src/data/dictionary.ts`, widen the field union:

```ts
export type DictionaryField = keyof EthRecord | 'input_tx' | 'normalized_quantity'
```

Widen `availability` and its doc comment:

```ts
  /**
   * `'loaded'` — the value is on every `EthRecord` in memory.
   * `'on-demand'` — documented, but fetched per row through `CalldataProvider`.
   * `'derived'` — not in the dataset at all; computed in the browser from other fields.
   * Anything that reads a value off a live record must iterate `LOADED_COLUMNS`, not
   * `COLUMNS` — neither of the latter two has a value to read.
   */
  availability: 'loaded' | 'on-demand' | 'derived'
```

Insert into `COLUMNS` immediately after the `quantity` entry (line 46):

```ts
  { field: 'normalized_quantity', label: 'Normalized Quantity', description: 'Quantity divided by the token contract’s decimals (quantity ÷ 10^decimals) — the amount in the units people actually use, e.g. 80 USDT rather than the stored 80000000. Computed in the browser from a token-decimals lookup; contracts absent from that lookup show no value.', source: 'derived', kind: 'bignum', availability: 'derived' },
```

`LOADED_COLUMNS` needs no change — its predicate is already `c.availability === 'loaded'`.

- [ ] **Step 5: Keep the row-detail partition in sync**

In `src/features/table/rowDetailFields.ts`, add the field to the `Token Transfer` group, right after `'quantity'`:

```ts
      'operator_address', 'from_address', 'to_address', 'token_id', 'quantity',
      'normalized_quantity', 'removed',
```

Update the comment above `GROUPS` — it says "All 35 dictionary fields":

```ts
// All 36 dictionary fields, partitioned into the brief's three groups. Order within each
```

- [ ] **Step 6: Render the derived value in the row detail**

In `src/features/table/RowDetail.tsx`, add the imports:

```ts
import { formatNormalizedQuantity } from '../../data/transform'
import { lookupToken, type TokenRegistry } from '../../data/tokenRegistry'
```

Add `tokens: TokenRegistry` to the component's props interface and destructure it. Then, inside the `group.fields.map` callback, immediately **before** the existing `const raw = rawString(...)` line (currently line 62), insert:

```ts
              // Derived fields have no value on the record — `record[field]` would be
              // undefined and render as a dash. This one is computed the same way the
              // table cell computes it, so an expanded row can't disagree with the row
              // above it.
              if (field === 'normalized_quantity') {
                const token = lookupToken(tokens, record.address)
                const text =
                  token == null ? null : formatNormalizedQuantity(record.quantity, token.decimals)
                return (
                  <div key={String(field)} className="row-detail__field">
                    <span className="row-detail__field-label">{meta?.label ?? String(field)}</span>
                    {text == null ? (
                      <span className="row-detail__field-value row-detail__field-value--empty">–</span>
                    ) : (
                      <span className="row-detail__field-value">
                        <span className="row-detail__field-raw">{text}</span>
                        {token?.symbol && (
                          <span className="row-detail__field-human">{token.symbol}</span>
                        )}
                      </span>
                    )}
                  </div>
                )
              }
```

- [ ] **Step 7: Add the `'derived'` branch to the dictionary panel**

In `src/features/dictionary/DictionaryPanel.tsx` at line 305, the detail view currently branches on `meta.availability === 'on-demand'`. Change it to handle all three, keeping the existing on-demand markup untouched and adding:

```tsx
      {meta.availability === 'derived' ? (
        <p className="dictionary-detail__note">Computed in the browser — not a stored dataset column.</p>
      ) : meta.availability === 'on-demand' ? (
```

At line 408, beside the existing `On demand` badge in the list, add the parallel case:

```tsx
                    ) : c.availability === 'derived' ? (
                      <span className="dictionary-entry__on-demand">Derived</span>
```

The stats lookup at line 397 (`c.availability === 'loaded' ? … : undefined`) already excludes derived fields — leave it alone.

- [ ] **Step 8: Thread the registry down to both RowDetail call sites**

`RowDetail` has exactly two call sites — the inline expanded row and the fullscreen dialog —
and the registry has to reach both, or an expanded row and its fullscreen promotion would
disagree. Four edits:

1. `src/features/table/DataTable.tsx` — add to `DataTableProps`:

```ts
  /** Token decimals lookup, for the derived Normalized Quantity column. Empty is valid. */
  tokens: TokenRegistry
```

Destructure `tokens` in the component signature, and import the type:

```ts
import type { TokenRegistry } from '../../data/tokenRegistry'
```

2. `DataTable.tsx:269` — `<RowDetail record={row.original} tokens={tokens} />`

3. `src/features/table/RowFullscreen.tsx` — add `tokens: TokenRegistry` to
   `RowFullscreenProps` (importing the type as above), destructure it, and pass it on at
   line 93: `<RowDetail record={record} tokens={tokens} />`. Then at `DataTable.tsx:328`,
   add `tokens={tokens}` to the `<RowFullscreen>` element.

4. `src/features/table/__fixtures__/tableHarness.tsx` — add `tokens={EMPTY_TOKEN_REGISTRY}`
   to the `<DataTable>` element, importing it from `../../../data/tokenRegistry`. This keeps
   every pre-existing table test compiling; Task 6 replaces it with a parameter.

- [ ] **Step 9: Run the tests**

Run: `npx vitest run src/data/dictionary.test.ts src/features/table/RowDetail.test.ts src/features/dictionary`
Expected: PASS. The `RowDetail` drift test now sees 36 fields on both sides.

Run: `npm run build`
Expected: type-check clean.

- [ ] **Step 10: Commit**

```bash
git add src/data/dictionary.ts src/data/dictionary.test.ts src/features/table/rowDetailFields.ts src/features/table/RowDetail.tsx src/features/table/RowFullscreen.tsx src/features/dictionary/DictionaryPanel.tsx src/features/table/DataTable.tsx src/features/table/__fixtures__/tableHarness.tsx
git commit -m "feat: document normalized quantity as a derived dictionary column"
```

---

### Task 5: The cell renderer

**Files:**
- Modify: `src/features/table/CellRenderers.tsx`
- Modify: `src/features/table/table.css`
- Test: `src/features/table/CellRenderers.test.tsx` (create if absent)

**Interfaces:**
- Consumes: `formatNormalizedQuantity` (Task 1); `TokenInfo` (Task 2).
- Produces: `NormalizedQuantityCell({ quantity, token }: { quantity: string | null; token: TokenInfo | null })`

- [ ] **Step 1: Write the failing tests**

Create `src/features/table/CellRenderers.test.tsx` (or append if it exists):

```tsx
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { NormalizedQuantityCell } from './CellRenderers'

const USDT = { symbol: 'USDT', decimals: 6 }
const WETH = { symbol: 'WETH', decimals: 18 }

describe('NormalizedQuantityCell', () => {
  it('renders the normalized value with its symbol', () => {
    render(<NormalizedQuantityCell quantity="80000000" token={USDT} />)
    expect(screen.getByText('80')).toBeInTheDocument()
    expect(screen.getByText('USDT')).toBeInTheDocument()
  })

  it('marks dust rather than showing a bare zero', () => {
    render(<NormalizedQuantityCell quantity="5" token={WETH} />)
    expect(screen.getByText('<0.000001')).toBeInTheDocument()
  })

  it('explains itself when the contract has no known decimals', () => {
    const { container } = render(<NormalizedQuantityCell quantity="80000000" token={null} />)
    expect(container.querySelector('.cell-null-explained')).toHaveAttribute(
      'title',
      'Token decimals unknown — this contract is not in the token registry',
    )
  })

  it('renders a plain null cell when there is no quantity at all', () => {
    // Transaction rows carry no quantity; that is missing data, not missing metadata.
    const { container } = render(<NormalizedQuantityCell quantity={null} token={USDT} />)
    expect(container.querySelector('.cell-null')).toBeInTheDocument()
    expect(container.querySelector('.cell-null-explained')).toBeNull()
  })

  it('renders a token with no symbol as just the number', () => {
    render(<NormalizedQuantityCell quantity="4200" token={{ symbol: null, decimals: 2 }} />)
    expect(screen.getByText('42')).toBeInTheDocument()
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/features/table/CellRenderers.test.tsx`
Expected: FAIL — `NormalizedQuantityCell` is not exported.

- [ ] **Step 3: Write the implementation**

Add to `src/features/table/CellRenderers.tsx` — extend the existing import from `../../data/transform` with `formatNormalizedQuantity`, and add:

```tsx
import type { TokenInfo } from '../../data/tokenRegistry'
```

```tsx
/**
 * A dash that says *why* it is a dash. The plain `NullCell` means "this row has no value
 * here"; this one means "the value exists on-chain but we can't scale it", which is a
 * property of our lookup, not of the row. Worth distinguishing: it is the majority case —
 * only 64 of the dataset's 955 token contracts have known decimals.
 */
function UnknownDecimalsCell() {
  return (
    <span
      className="cell-null cell-null-explained"
      title="Token decimals unknown — this contract is not in the token registry"
    >
      –
    </span>
  )
}

/**
 * `quantity ÷ 10^decimals` with the token's symbol — the amount as a person would state it,
 * beside the raw stored integer in the Quantity column. Ethereum has no fractional integers,
 * so every divisible token stores a scaled integer and declares the scale as `decimals`;
 * without this column an 80 USDT transfer reads as 80,000,000.
 *
 * Zero renders faint (a real, meaningful value — same treatment as `EthValueCell`), while a
 * non-zero amount too small to display renders `<0.000001` rather than collapsing to "0".
 */
export function NormalizedQuantityCell({
  quantity,
  token,
}: {
  quantity: string | null
  token: TokenInfo | null
}) {
  if (quantity == null) return <NullCell />
  if (token == null) return <UnknownDecimalsCell />
  const text = formatNormalizedQuantity(quantity, token.decimals)
  if (text == null) return <UnknownDecimalsCell />
  const isZero = text === '0'
  return (
    <span className={`num-cell${isZero ? ' num-cell--faint' : ''}`}>
      {text}
      {token.symbol && <span className="num-cell__unit"> {token.symbol}</span>}
    </span>
  )
}
```

- [ ] **Step 4: Give the explained dash a cursor hint**

Append to `src/features/table/table.css`, next to the existing `.cell-null` rule:

```css
/* Signals that the dash carries a tooltip explaining why the value is absent. */
.cell-null-explained {
  cursor: help;
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run src/features/table/CellRenderers.test.tsx`
Expected: PASS (5 tests).

- [ ] **Step 6: Commit**

```bash
git add src/features/table/CellRenderers.tsx src/features/table/CellRenderers.test.tsx src/features/table/table.css
git commit -m "feat: normalized quantity cell with dust marker and explained dash"
```

---

### Task 6: Column wiring — sort and filter

**Files:**
- Modify: `src/features/table/filters.ts`
- Modify: `src/features/table/columns.tsx`
- Modify: `src/features/table/DataTable.tsx:49-51`
- Modify: `src/features/table/__fixtures__/tableHarness.tsx`
- Test: `src/features/table/filters.test.ts` (append), `src/features/table/DataTable.normalizedQuantity.test.tsx` (create)

**Interfaces:**
- Consumes: `compareNormalizedQuantity` (Task 1); `TokenRegistry`, `lookupToken`, `tokenDecimals`, `EMPTY_TOKEN_REGISTRY` (Task 2); `NormalizedQuantityCell` (Task 5).
- Produces:
  - `normalizedRangeFilter(quantity: string | null, decimals: number | null, range: RangeFilterValue): boolean` in `filters.ts`
  - `getColumnsForTab(tab: TabId, tokens: TokenRegistry): ColumnDef<EthRecord>[]` — **signature change**
  - `DataTableProps.tokens: TokenRegistry` (added in Task 4; now consumed)

- [ ] **Step 1: Write the failing filter test**

Append to `src/features/table/filters.test.ts`:

```ts
describe('normalizedRangeFilter', () => {
  it('passes every row when no bound is set', () => {
    expect(normalizedRangeFilter('80000000', 6, {})).toBe(true)
    expect(normalizedRangeFilter('80000000', null, {})).toBe(true)
    expect(normalizedRangeFilter(null, 6, {})).toBe(true)
  })

  it('scales the bound by the row’s own decimals', () => {
    // "1" means one whole token, so 80 USDT passes and 0.5 USDT does not.
    expect(normalizedRangeFilter('80000000', 6, { min: '1' })).toBe(true)
    expect(normalizedRangeFilter('500000', 6, { min: '1' })).toBe(false)
    // The same bound against an 18-decimal token.
    expect(normalizedRangeFilter('1000000000000000000', 18, { min: '1' })).toBe(true)
    expect(normalizedRangeFilter('500000000000000000', 18, { min: '1' })).toBe(false)
  })

  it('accepts fractional bounds', () => {
    expect(normalizedRangeFilter('500000000000000000', 18, { min: '0.5' })).toBe(true)
    expect(normalizedRangeFilter('400000000000000000', 18, { min: '0.5' })).toBe(false)
  })

  it('applies max bounds and both bounds together', () => {
    expect(normalizedRangeFilter('80000000', 6, { max: '100' })).toBe(true)
    expect(normalizedRangeFilter('80000000', 6, { max: '50' })).toBe(false)
    expect(normalizedRangeFilter('80000000', 6, { min: '50', max: '100' })).toBe(true)
  })

  it('excludes rows with unknown decimals or no quantity once a bound is set', () => {
    expect(normalizedRangeFilter('80000000', null, { min: '1' })).toBe(false)
    expect(normalizedRangeFilter(null, 6, { min: '1' })).toBe(false)
  })

  it('treats an unparseable bound as not set, so mid-typing never blanks the table', () => {
    expect(normalizedRangeFilter('80000000', 6, { min: 'abc' })).toBe(true)
    expect(normalizedRangeFilter('80000000', 6, { min: '0.' })).toBe(true)
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/features/table/filters.test.ts`
Expected: FAIL — `normalizedRangeFilter is not defined`.

- [ ] **Step 3: Implement the pure filter**

In `src/features/table/filters.ts`, extend the `../../data/transform` import with `isValidDecimals`, and add after `rangeFilter`:

```ts
/**
 * Range filter for the derived Normalized Quantity column. Bounds are typed in *token units*
 * — "≥ 1" means one whole token — but each row is stored at its own contract's scale, so the
 * bound is converted per row via that row's `decimals` before the ordinary BigInt comparison.
 * A single fixed exponent (the `rangeEth`/`rangeGwei` approach) cannot work here: the unit
 * genuinely differs from row to row.
 *
 * A row whose decimals are unknown fails any set bound — it has no normalized value to
 * compare, the same reason `rangeFilter` rejects a null cell.
 */
export function normalizedRangeFilter(
  quantity: string | null,
  decimals: number | null,
  range: RangeFilterValue,
): boolean {
  const minStr = range.min?.trim()
  const maxStr = range.max?.trim()
  if (!minStr && !maxStr) return true
  if (!isValidDecimals(decimals) || quantity == null) return false
  const min = minStr ? (decimalToWei(minStr, decimals) ?? undefined) : undefined
  const max = maxStr ? (decimalToWei(maxStr, decimals) ?? undefined) : undefined
  return rangeFilter(quantity, { min, max })
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `npx vitest run src/features/table/filters.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing column test**

Create `src/features/table/DataTable.normalizedQuantity.test.tsx`:

```tsx
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { DataTable } from './DataTable'
import { DictionaryPanelProvider } from '../dictionary/DictionaryPanel'
import { parseTokenRegistry } from '../../data/tokenRegistry'
import { mk } from './__fixtures__/tableHarness'
import type { BlockAxisEntry } from '../../data/types'

const REGISTRY = parseTokenRegistry({
  tokens: {
    '0xusdt': { symbol: 'USDT', decimals: 6 },
    '0xweth': { symbol: 'WETH', decimals: 18 },
  },
})

// 80 USDT, 0.5 WETH, and a contract absent from the registry (the USDC case).
const RECORDS = [
  mk({ transaction_hash: '0x1', address: '0xusdt', quantity: '80000000', block_number: 25534200 }),
  mk({ transaction_hash: '0x2', address: '0xweth', quantity: '500000000000000000', block_number: 25534201 }),
  mk({ transaction_hash: '0x3', address: '0xunknown', quantity: '12345', block_number: 25534202 }),
]

const AXIS: BlockAxisEntry[] = [
  { block: 25534200, time: '2026-07-14 23:35:11+00:00' },
  { block: 25534201, time: '2026-07-14 23:35:23+00:00' },
  { block: 25534202, time: '2026-07-14 23:35:35+00:00' },
]

function renderTable(tab: 'transfers' | 'transactions' | 'all' = 'transfers') {
  render(
    <DictionaryPanelProvider records={RECORDS}>
      <DataTable
        records={RECORDS}
        tab={tab}
        tokens={REGISTRY}
        blockAxis={AXIS}
        globalFilter=""
        onGlobalFilterChange={vi.fn()}
      />
    </DictionaryPanelProvider>,
  )
}

function headerTexts() {
  const head = document.querySelector('thead')
  return Array.from(head!.querySelectorAll('th')).map((th) => th.textContent ?? '')
}

describe('Normalized Quantity column', () => {
  it('sits immediately right of Quantity on the transfers tab', () => {
    renderTable()
    const headers = headerTexts()
    const q = headers.findIndex((h) => h.includes('Quantity') && !h.includes('Normalized'))
    expect(headers[q + 1]).toContain('Normalized Quantity')
  })

  it('is absent from the transactions and all-records tabs', () => {
    renderTable('transactions')
    expect(headerTexts().join(' ')).not.toContain('Normalized Quantity')
  })

  it('shows the normalized value with its symbol, and a dash for unknown contracts', () => {
    renderTable()
    expect(screen.getByText('80')).toBeInTheDocument()
    expect(screen.getByText('USDT')).toBeInTheDocument()
    expect(screen.getByText('0.5')).toBeInTheDocument()
    expect(document.querySelector('.cell-null-explained')).toBeInTheDocument()
  })

  it('sorts across token scales, not by the raw integer', async () => {
    const user = userEvent.setup()
    renderTable()
    const thead = document.querySelector('thead')!
    await user.click(within(thead).getByRole('button', { name: /^Normalized Quantity(,|$)/ }))

    // First click descends (it is a magnitude): 80 USDT before 0.5 WETH, even though
    // WETH's raw quantity (5e17) is the larger integer. The unknown-decimals row sorts last.
    const firstCol = Array.from(document.querySelectorAll('tbody tr'))
      .map((tr) => tr.querySelectorAll('td')[0]?.textContent ?? '')
    expect(firstCol[0]).toContain('23:35:11') // the USDT row
    expect(firstCol[1]).toContain('23:35:23') // the WETH row
    expect(firstCol[2]).toContain('23:35:35') // the unknown row, last
  })
})
```

- [ ] **Step 6: Run it to verify it fails**

Run: `npx vitest run src/features/table/DataTable.normalizedQuantity.test.tsx`
Expected: FAIL — no `Normalized Quantity` header.

- [ ] **Step 7: Add the column definition**

In `src/features/table/columns.tsx`, add imports:

```ts
import { compareNormalizedQuantity } from '../../data/transform'
import { lookupToken, tokenDecimals, type TokenRegistry } from '../../data/tokenRegistry'
import { normalizedRangeFilter, type RangeFilterValue } from './filters'
import { NormalizedQuantityCell } from './CellRenderers'
```

(`compareNumericStrings` is already imported from `../../data/transform` — extend that line rather than adding a second import.)

Add above `transferColumns`:

```ts
/**
 * The derived Normalized Quantity column. Its sort and filter close over the registry rather
 * than being registered by string key (the `bignum`/`rangeEth` pattern) because they need
 * per-row metadata that isn't on the record — TanStack accepts a function directly, so no
 * module augmentation is needed.
 *
 * The accessor returns the raw `quantity`; everything that needs the divisor reads
 * `row.original.address` and looks it up.
 */
function normalizedQuantityColumn(tokens: TokenRegistry): ColumnDef<EthRecord> {
  return helper.accessor((r) => r.quantity, {
    id: 'normalized_quantity',
    header: header('transfers', 'normalized_quantity', { label: 'token units', decimals: 18 }),
    cell: (info) => (
      <NormalizedQuantityCell
        quantity={info.row.original.quantity}
        token={lookupToken(tokens, info.row.original.address)}
      />
    ),
    // A magnitude, like the `quantity` column it mirrors — biggest first is the interesting
    // read. Not added to DESC_FIRST_FIELDS, which is keyed to the raw dictionary fields.
    sortDescFirst: true,
    sortingFn: (rowA, rowB) =>
      compareNormalizedQuantity(
        rowA.original.quantity,
        tokenDecimals(tokens, rowA.original.address),
        rowB.original.quantity,
        tokenDecimals(tokens, rowB.original.address),
      ),
    filterFn: (row, _columnId, filterValue: RangeFilterValue | undefined) =>
      normalizedRangeFilter(
        row.original.quantity,
        tokenDecimals(tokens, row.original.address),
        filterValue ?? {},
      ),
  }) as ColumnDef<EthRecord>
}
```

Note on the `header(...)` unit argument: `RangeUnit.decimals` drives only the popover's own bound *validation* (`FilterControls.boundToComparable`) and its `inputMode`, not the row comparison — the real per-row scaling happens in `normalizedRangeFilter` above. 18 is passed because it is the widest scale in this dataset, so no realistic bound is rejected as unparseable. The label makes the unit explicit: the inputs read `Min (token units)`.

- [ ] **Step 8: Make the tab column sets registry-aware**

In the same file, convert `transferColumns` from a `const` array to a function, inserting the new column directly after the `quantity` accessor:

```ts
function transferColumns(tokens: TokenRegistry): ColumnDef<EthRecord>[] {
  return [
    // …every existing entry unchanged…
    helper.accessor('quantity', {
      header: header('transfers', 'quantity'),
      cell: (info) => <BigNumCell value={info.getValue()} />,
      sortingFn: 'bignum',
      sortDescFirst: descFirst('quantity'),
      filterFn: filterFor('quantity'),
    }),
    normalizedQuantityColumn(tokens),
    // …token_id and event_index unchanged…
  ] as ColumnDef<EthRecord>[]
}
```

Leave `transactionColumns` and `allColumns` as module-level constants — neither gains the column.

Update the export:

```ts
/**
 * `tokens` is only consumed by the transfers tab's derived Normalized Quantity column; the
 * other two tabs ignore it and still return their module-level constant arrays.
 */
export function getColumnsForTab(tab: TabId, tokens: TokenRegistry): ColumnDef<EthRecord>[] {
  switch (tab) {
    case 'transfers':
      return transferColumns(tokens)
    case 'transactions':
      return transactionColumns
    case 'all':
      return allColumns
  }
}
```

- [ ] **Step 9: Memoize in DataTable and fix the stale comment**

In `src/features/table/DataTable.tsx`, add `useMemo` to the `react` import, then replace lines 49-51:

```ts
  // The transfers tab now builds its column array per call (it closes over `tokens` for the
  // derived Normalized Quantity column), so this can no longer rely on the old module-level
  // constant identity — without the memo, every render would hand useReactTable a new
  // column array and reset its internal column state.
  const columns = useMemo(() => getColumnsForTab(tab, tokens), [tab, tokens])
```

- [ ] **Step 10: Let the harness supply a registry**

In `src/features/table/__fixtures__/tableHarness.tsx`, change the render helper so existing tests keep working unchanged while new ones can pass a registry:

```tsx
export function renderTransfersTable(tokens: TokenRegistry = EMPTY_TOKEN_REGISTRY) {
  render(
    <DictionaryPanelProvider records={TEST_RECORDS}>
      <DataTable
        records={TEST_RECORDS}
        tab="transfers"
        tokens={tokens}
        blockAxis={TEST_AXIS}
        globalFilter=""
        onGlobalFilterChange={vi.fn()}
      />
    </DictionaryPanelProvider>,
  )
}
```

- [ ] **Step 11: Run the tests**

Run: `npx vitest run src/features/table`
Expected: PASS, including every pre-existing table suite.

Run: `npm run build`
Expected: type-check clean.

- [ ] **Step 12: Commit**

```bash
git add src/features/table/filters.ts src/features/table/filters.test.ts src/features/table/columns.tsx src/features/table/DataTable.tsx src/features/table/DataTable.normalizedQuantity.test.tsx src/features/table/__fixtures__/tableHarness.tsx
git commit -m "feat: normalized quantity column with cross-scale sort and per-row filter"
```

---

### Task 7: Load the registry in App

**Files:**
- Modify: `src/App.tsx`

**Interfaces:**
- Consumes: `tokenRegistryProvider`, `EMPTY_TOKEN_REGISTRY`, `TokenRegistry` (Task 2); `DataTableProps.tokens` (Tasks 4/6).
- Produces: a `tokens` value passed to `<DataTable>` and (in Task 8) `<ExportButton>`.

- [ ] **Step 1: Add the imports and state**

In `src/App.tsx`, add:

```ts
import { EMPTY_TOKEN_REGISTRY, tokenRegistryProvider, type TokenRegistry } from './data/tokenRegistry'
```

Beside the existing dataset state:

```ts
  const [tokens, setTokens] = useState<TokenRegistry>(EMPTY_TOKEN_REGISTRY)
```

- [ ] **Step 2: Load it in its own effect**

Add after the existing dataset-loading effect:

```ts
  // Loaded separately from the rows, and deliberately never awaited alongside them: the
  // decimals lookup is an enhancement, not a dependency. `tokenRegistryProvider` already
  // resolves to an empty registry on any failure, so a missing tokens.json costs the
  // Normalized Quantity column its values and nothing else. Runs once — unlike the dataset
  // effect it has no retry token, because there is no error state for the user to retry from.
  useEffect(() => {
    let cancelled = false
    tokenRegistryProvider()
      .load()
      .then((registry) => {
        if (!cancelled) setTokens(registry)
      })
    return () => {
      cancelled = true
    }
  }, [])
```

- [ ] **Step 3: Pass it to the table**

At the `<DataTable` element (around line 265), add the prop:

```tsx
                tokens={tokens}
```

- [ ] **Step 4: Verify**

Run: `npm run build`
Expected: type-check clean.

Run: `npm test`
Expected: the whole suite passes.

- [ ] **Step 5: Check it in the real app**

Run: `npm run dev`, open the Token Transfers tab, and confirm:
- A `Normalized Quantity` header sits right of `Quantity`.
- USDT rows (`0xdac17f95…`) show a value with a `USDT` suffix.
- USDC rows (`0xa0b86991…`) show a dash whose tooltip explains why.
- Clicking the header sorts descending first, and the dashes sink to the bottom.
- The funnel opens a Min/Max popover labelled `(token units)`; typing `1` in Min hides sub-1-token rows of every token.

- [ ] **Step 6: Commit**

```bash
git add src/App.tsx
git commit -m "feat: load the token decimals registry alongside the dataset"
```

---

### Task 8: CSV export

**Files:**
- Modify: `src/features/export/exportCsv.ts`
- Modify: `src/features/export/ExportButton.tsx`
- Modify: `src/App.tsx` (the `<ExportButton>` element, ~line 250)
- Test: `src/features/export/exportCsv.test.ts` (append)

**Interfaces:**
- Consumes: `normalizeQuantity` (Task 1); `TokenRegistry`, `tokenDecimals` (Task 2).
- Produces:
  - `type DerivedCells = Record<string, (record: EthRecord) => string>`
  - `buildCsv(rows: EthRecord[], fields: string[], derived?: DerivedCells): string` — **signature change**
  - `ExportButtonProps.tokens: TokenRegistry`

- [ ] **Step 1: Write the failing tests**

Append to `src/features/export/exportCsv.test.ts`:

The file already has a `makeRecord(overrides)` factory and a `LOSSLESS_VALUE` constant at the
top — reuse both rather than declaring new ones.

```ts
describe('buildCsv derived columns', () => {
  const record = makeRecord({ address: '0xusdt', quantity: '80000000' })

  it('resolves a derived column through the supplied resolver', () => {
    const csv = buildCsv([record], ['quantity', 'normalized_quantity'], {
      normalized_quantity: (r) => (r.quantity === '80000000' ? '80' : ''),
    })
    expect(csv).toContain('quantity,normalized_quantity')
    expect(csv).toContain('80000000,80')
  })

  it('emits an empty cell for a derived column with no resolver', () => {
    const csv = buildCsv([record], ['quantity', 'normalized_quantity'])
    expect(csv).toContain('80000000,')
  })

  it('still exports plain record fields losslessly', () => {
    // Regression guard: the signature widened from (keyof EthRecord)[] to string[].
    const big = makeRecord({ value_lossless_tx: LOSSLESS_VALUE })
    const csv = buildCsv([big], ['value_lossless_tx'])
    expect(csv).toContain(LOSSLESS_VALUE)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/features/export/exportCsv.test.ts`
Expected: FAIL — `buildCsv` takes two arguments.

- [ ] **Step 3: Widen buildCsv**

In `src/features/export/exportCsv.ts`:

```ts
/**
 * Resolvers for columns that exist on screen but not on the record — currently only
 * `normalized_quantity`, which is computed from `quantity` and a token-decimals lookup.
 * Keyed by column id, which is what `getVisibleLeafColumns()` reports.
 */
export type DerivedCells = Record<string, (record: EthRecord) => string>

function cellValue(record: EthRecord, field: string): string {
  const v = record[field as keyof EthRecord]
  if (v == null) return ''
  if (typeof v === 'boolean') return v ? 'True' : 'False'
  return String(v)
}

export function buildCsv(rows: EthRecord[], fields: string[], derived?: DerivedCells): string {
  const data = rows.map((row) =>
    fields.map((field) => derived?.[field]?.(row) ?? cellValue(row, field)),
  )
  return Papa.unparse({ fields, data })
}
```

Keep the existing docstring above `buildCsv` and add to it:

```
 * A field with a `derived` resolver takes its value from that resolver instead of the
 * record. Derived values are written at full precision with no display formatting, for the
 * same round-trip reason as the raw columns.
```

- [ ] **Step 4: Supply the resolver**

In `src/features/export/ExportButton.tsx`, add imports:

```ts
import { normalizeQuantity } from '../../data/transform'
import { tokenDecimals, type TokenRegistry } from '../../data/tokenRegistry'
```

Add `tokens: TokenRegistry` to `ExportButtonProps` and destructure it. In `handleExport`, replace the `const fields = …` block and the `buildCsv` call:

```ts
    const fields = allColumns
      ? (LOADED_COLUMNS.map((c) => c.field) as string[])
      : table.getVisibleLeafColumns().map((c) => c.id)

    // The exact, full-precision value — no thousands separators and no symbol, unlike the
    // on-screen cell. Display truncation must not reach the file: the export is meant to
    // re-import losslessly, the same rule the raw numeric columns follow.
    const derived = {
      normalized_quantity: (r: EthRecord) => {
        const decimals = tokenDecimals(tokens, r.address)
        return decimals == null ? '' : (normalizeQuantity(r.quantity, decimals) ?? '')
      },
    }

    const csv = buildCsv(records, fields, derived)
```

The "All 34 columns" path is unaffected: the derived column is not in `LOADED_COLUMNS`, so its resolver never fires and the menu label stays accurate.

- [ ] **Step 5: Pass the registry from App**

In `src/App.tsx` at the `<ExportButton` element, add:

```tsx
                    tokens={tokens}
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx vitest run src/features/export`
Expected: PASS.

Run: `npm run build`
Expected: type-check clean.

- [ ] **Step 7: Commit**

```bash
git add src/features/export/exportCsv.ts src/features/export/exportCsv.test.ts src/features/export/ExportButton.tsx src/App.tsx
git commit -m "feat: export normalized quantity at full precision"
```

---

### Task 9: Documentation and final verification

**Files:**
- Modify: `README.md`

**Interfaces:**
- Consumes: everything above. Produces: no code.

- [ ] **Step 1: Update the README**

Three edits, matching the file's existing voice:

1. In **Dataset provenance**, after the paragraph about the two joined tables, add:

```markdown
A third BigQuery export, `tokens.csv` (223,930 token contracts, gitignored), supplies each
token contract's `decimals` — the scale factor every ERC-20 quantity is stored against,
since Ethereum has no fractional integers. `npm run data:tokens` distills it to
`public/data/tokens.json`, keeping only the contracts this dataset references.

**Coverage is partial and the gap is not random.** Of the 955 token contracts in the
dataset, 64 have usable decimals, covering 20,352 of 43,941 transfer rows (46.3%). USDC is
absent from the token export and is alone 25% of all transfers. Rows whose decimals are
unknown show a dash rather than a guessed divisor — a wrong scale is off by orders of
magnitude, which is worse than no answer.
```

2. In **What's in the app** under **Three views**, note the new column alongside the existing ETH/Gwei mention:

```markdown
  *Token Transfers* gains a **Normalized Quantity** column (`quantity ÷ 10^decimals`, shown
  with the token symbol) beside the raw stored `Quantity` — an 80 USDT transfer reads as
  `80 USDT` rather than `80,000,000`. It sorts correctly across tokens of different scales
  and filters on bounds typed in token units.
```

3. In the **Quickstart**/pipeline command list, beside `npm run data:prep`:

```markdown
npm run data:tokens   # rebuild public/data/tokens.json from tokens.csv
```

Also update the field count if the README states "35 documented fields" — it is now 36 (35 dataset fields plus one derived column).

- [ ] **Step 2: Run the full verification**

Run: `npm test`
Expected: every suite passes. Record the count.

Run: `npm run build`
Expected: type-check and production bundle both succeed.

Run: `npm run lint`
Expected: clean.

- [ ] **Step 3: Confirm the end-to-end numbers**

Run:
```bash
node -e "const a=require('./public/data/tokens.json');console.log(a.contractsInDataset, a.contractsWithDecimals, a.tokens['0xdac17f958d2ee523a2206206994597c13d831ec7'])"
```
Expected: `955 64 { symbol: 'USDT', decimals: 6 }`

- [ ] **Step 4: Commit**

```bash
git add README.md
git commit -m "docs: normalized quantity column and token decimals pipeline"
```

---

## Self-Review

**Spec coverage** — every design section maps to a task:

| Spec section | Task |
|---|---|
| 1. Build-time artifact | 3 |
| 2. Runtime registry | 2, 7 |
| 3. Math | 1 |
| 4. Column wiring | 5, 6 |
| 5. Dictionary | 4 |
| 6. Export | 8 |
| 7. Error handling | 1 (invalid decimals), 2 (load failures), 5 (dash rendering), 6 (filter exclusion) |
| 8. Testing | every task |

**Known deviation from the spec:** the row-detail panel. Flagged in *Spec addendum* above and implemented in Task 4 — the spec did not anticipate that `RowDetail.test.ts`'s drift test forces the decision.

**Pre-existing tests this plan knowingly rewrites.** Each was checked against the real file, and each fails for a correct reason rather than a regression:

| Test | File | Why it must change | Fixed in |
|---|---|---|---|
| `documents all 35 CSV columns in CSV order` | `dictionary.test.ts:5` | Asserts `COLUMNS` length 35 and `COLUMNS[34]`; the 36th entry shifts both | Task 4, Step 1 |
| `every column declares a valid availability` | `dictionary.test.ts:31` | Allow-list lacks `'derived'` | Task 4, Step 1 |
| `LOADED_COLUMNS is the 34 in-memory columns…` | `dictionary.test.ts:37` | Its equality assertion assumes `input_tx` is the only non-loaded field | Task 4, Step 1 |
| `RowDetail GROUPS` drift tests | `RowDetail.test.ts:8` | Asserts set-equality with `COLUMNS` | Task 4, Step 5 (adding the field to the group, not weakening the test) |

`marks exactly one field as on-demand` and `every column has a non-empty description and a source` were checked and need no change — `'derived'` is already an accepted `source`.

**Type consistency check:** `TokenInfo`, `TokenRegistry`, `lookupToken`, `tokenDecimals`, `EMPTY_TOKEN_REGISTRY`, `parseTokenRegistry`, `tokenRegistryProvider` (Task 2) are used with those exact names in Tasks 4, 5, 6, 7 and 8. `normalizeQuantity` / `formatNormalizedQuantity` / `compareNormalizedQuantity` / `isValidDecimals` (Task 1) likewise. Two signature changes are called out where they occur and updated at every call site: `getColumnsForTab` gains a second parameter (Task 6, call site in `DataTable.tsx`), and `buildCsv` widens `fields` to `string[]` plus an optional third argument (Task 8, call site in `ExportButton.tsx`). `DataTableProps.tokens` is introduced in Task 4 — earlier than it is consumed in Task 6 — because Task 4's `RowDetail` change needs it and the type-checker must stay green between commits.
