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
