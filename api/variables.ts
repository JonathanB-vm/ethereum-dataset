/**
 * Research variables over the API.
 *
 * The catalog is the registry seed (registry/variables.json) merged with eth.variables,
 * where approved researcher requests land; a database entry wins over a seed entry of the
 * same id. Values come from eth.tx_variable_values and are attached to list pages only
 * when asked for: `?variables=a,b` is opt-in so a page's payload does not grow with every
 * variable anyone defines.
 */

import type { BuiltQuery } from './queries.ts'
import { ScopeError } from './scope.ts'
import type { AppUser, CatalogEntry } from './store.ts'
import {
  getVariable,
  resolveCreator,
  searchVariables,
  VARIABLES,
  type User,
  type VariableDefinition,
} from '../registry/registry.ts'

/** A catalog entry as the API returns it: the creator resolved from an id to a user. */
export interface VariableResource extends Omit<VariableDefinition, 'created_by'> {
  created_by: User
  status?: 'active' | 'retired'
  approved_by?: User | null
  approved_at?: string | null
}

export function toResource(v: VariableDefinition): VariableResource {
  return { ...v, created_by: resolveCreator(v) }
}

/** A database catalog row in the registry's shape, so both sources flow through one path. */
export function entryToDefinition(e: CatalogEntry): VariableDefinition & {
  status: 'active' | 'retired'
  approved_by: string
  approved_at: string | null
} {
  return {
    id: e.id,
    label: e.label,
    description: e.description,
    tags: e.tags,
    created_by: e.createdBy,
    created_at: e.createdAt.slice(0, 10),
    grain: 'transaction',
    value_type: e.valueType === 'number' ? 'number' : 'flag',
    version: e.version,
    formula: { summary: e.formulaSummary, sql: e.formulaSql },
    status: e.status,
    approved_by: e.approvedBy,
    approved_at: e.approvedAt,
  }
}

/**
 * Seed plus database, active only, in a stable order (seed first, then by creation).
 * `users` resolves creators and approvers from the users table, falling back to the
 * registry's demo users.
 */
export function mergeCatalog(entries: CatalogEntry[], users: AppUser[]): VariableResource[] {
  const byId = new Map<string, VariableResource>()
  const userOf = (id: string): User => {
    const u = users.find((x) => x.id === id)
    return u ? { id: u.id, name: u.name } : resolveCreator({ created_by: id } as VariableDefinition)
  }
  for (const v of VARIABLES) byId.set(v.id, { ...toResource(v), status: 'active' })
  for (const e of entries) {
    const d = entryToDefinition(e)
    byId.set(d.id, {
      ...d,
      created_by: userOf(d.created_by),
      approved_by: d.approved_by ? userOf(d.approved_by) : null,
    })
  }
  return [...byId.values()].filter((v) => v.status !== 'retired')
}

export function filterCatalog(
  catalog: VariableResource[],
  criteria: { tag?: string; q?: string; created_by?: string },
): VariableResource[] {
  const asDefs = catalog.map((v) => ({ ...v, created_by: v.created_by.id }) as VariableDefinition)
  const keep = new Set(
    searchVariables(asDefs, { tag: criteria.tag, q: criteria.q, createdBy: criteria.created_by }).map((v) => v.id),
  )
  return catalog.filter((v) => keep.has(v.id))
}

/** Registry-only listing: what the catalog is when the database is unreachable. */
export function listVariables(criteria: { tag?: string; q?: string; created_by?: string }) {
  return filterCatalog(mergeCatalog([], []), criteria)
}

/** A page can carry at most this many variables; each costs one more range read. */
export const MAX_VARIABLES_PER_REQUEST = 20

/**
 * `?variables=a,b` -> the requested ids, in request order with duplicates dropped.
 * Absent or empty means none. An unknown id is a 400, not a silently missing column.
 */
export function parseVariablesParam(
  raw: string | undefined,
  isKnown: (id: string) => boolean = (id) => getVariable(id) !== undefined,
): string[] {
  if (raw == null || raw.trim() === '') return []
  const ids = [...new Set(raw.split(',').map((s) => s.trim()).filter((s) => s !== ''))]
  const unknown = ids.filter((id) => !isKnown(id))
  if (unknown.length > 0) throw new ScopeError(`unknown variable(s): ${unknown.join(', ')}`)
  if (ids.length > MAX_VARIABLES_PER_REQUEST) {
    throw new ScopeError(`at most ${MAX_VARIABLES_PER_REQUEST} variables per request`)
  }
  return ids
}

/**
 * Values of `ids` for every transaction in `[from, to]`.
 *
 * Bounded by the page's own block span. The table is sorted by (variable_id, block_number,
 * transaction_index), so this is one contiguous primary-key range per variable. Ids reach
 * the SQL only through a bound Array(String) parameter, and only after
 * `parseVariablesParam` matched each one against the registry.
 */
export function buildVariableValues(ids: string[], from: number, to: number): BuiltQuery {
  return {
    sql:
      'SELECT variable_id, block_number, transaction_index, value ' +
      'FROM tx_variable_values FINAL ' +
      'WHERE variable_id IN {ids:Array(String)} ' +
      'AND block_number >= {block_from:UInt32} AND block_number <= {block_to:UInt32}',
    params: {
      ids: `[${ids.map((id) => `'${id}'`).join(',')}]`,
      block_from: from,
      block_to: to,
    },
  }
}

interface ValueRow {
  variable_id: string
  block_number: number | string
  transaction_index: number | string
  value: number | string
}

/** The block span a page covers, for bounding its variable read. Null for an empty page. */
export function blockSpan(rows: Record<string, unknown>[]): { from: number; to: number } | null {
  if (rows.length === 0) return null
  let from = Infinity
  let to = -Infinity
  for (const r of rows) {
    const b = Number(r.block_number)
    if (b < from) from = b
    if (b > to) to = b
  }
  return { from, to }
}

/**
 * Adds each requested variable to each row as a top-level field named by its id, matched on
 * (block_number, transaction_index). A transaction the variable has not been computed for
 * gets `null`, never 0: "not computed" and "computed as no" must stay distinguishable.
 */
export function mergeVariableValues(
  rows: Record<string, unknown>[],
  ids: string[],
  values: ValueRow[],
): Record<string, unknown>[] {
  const byKey = new Map<string, Map<string, number>>()
  for (const v of values) {
    const key = `${Number(v.block_number)}:${Number(v.transaction_index)}`
    let entry = byKey.get(key)
    if (entry === undefined) {
      entry = new Map()
      byKey.set(key, entry)
    }
    entry.set(v.variable_id, Number(v.value))
  }
  return rows.map((row) => {
    const entry = byKey.get(`${Number(row.block_number)}:${Number(row.transaction_index)}`)
    const out = { ...row }
    for (const id of ids) out[id] = entry?.get(id) ?? null
    return out
  })
}

/**
 * Values rows plus catalog definitions -> the columnar payload the explorer parses
 * (`src/data/variableValues.ts`): one entry per transaction that has any value, in
 * (block, index) order, with a parallel array per variable and `null` where a variable
 * has no value for that transaction.
 */
export function columnarValues(rows: ValueRow[], defs: VariableResource[]) {
  const keyOf = (b: number, i: number) => b * 65_536 + i
  const keys = new Map<number, [number, number]>()
  for (const r of rows) {
    const b = Number(r.block_number)
    const i = Number(r.transaction_index)
    keys.set(keyOf(b, i), [b, i])
  }
  const ordered = [...keys.values()].sort((x, y) => x[0] - y[0] || x[1] - y[1])
  const position = new Map(ordered.map(([b, i], n) => [keyOf(b, i), n]))
  const values: Record<string, (number | null)[]> = {}
  for (const d of defs) values[d.id] = new Array(ordered.length).fill(null)
  for (const r of rows) {
    const column = values[r.variable_id]
    if (column) column[position.get(keyOf(Number(r.block_number), Number(r.transaction_index)))!] = Number(r.value)
  }
  return {
    schemaVersion: 1,
    blocks: ordered.map(([b]) => b),
    txIndexes: ordered.map(([, i]) => i),
    versions: Object.fromEntries(defs.map((d) => [d.id, d.version])),
    values,
    variables: defs,
  }
}
