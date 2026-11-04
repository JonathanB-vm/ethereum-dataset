/**
 * Research variables over the API.
 *
 * The catalog is served straight from the registry (registry/variables.json), which is
 * also what seeds ClickHouse's eth.variables, so the two cannot disagree in a deployment
 * that ran `variables:compute`. Values come from eth.tx_variable_values and are attached
 * to list pages only when asked for: `?variables=a,b` is opt-in so a page's payload does
 * not grow with every variable anyone defines.
 */

import type { BuiltQuery } from './queries.ts'
import { ScopeError } from './scope.ts'
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
}

export function toResource(v: VariableDefinition): VariableResource {
  return { ...v, created_by: resolveCreator(v) }
}

export function listVariables(criteria: { tag?: string; q?: string; created_by?: string }) {
  return searchVariables(VARIABLES, {
    tag: criteria.tag,
    q: criteria.q,
    createdBy: criteria.created_by,
  }).map(toResource)
}

/** A page can carry at most this many variables; each costs one more range read. */
export const MAX_VARIABLES_PER_REQUEST = 20

/**
 * `?variables=a,b` -> the requested ids, in request order with duplicates dropped.
 * Absent or empty means none. An unknown id is a 400, not a silently missing column.
 */
export function parseVariablesParam(raw: string | undefined): string[] {
  if (raw == null || raw.trim() === '') return []
  const ids = [...new Set(raw.split(',').map((s) => s.trim()).filter((s) => s !== ''))]
  const unknown = ids.filter((id) => getVariable(id) === undefined)
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
