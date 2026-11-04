/**
 * The research-variable registry: who exists, and which derived columns they have defined.
 *
 * A *variable* is a researcher's calculation over the dataset whose result is one new
 * column. The definitions here are the seed of truth until a creation UI exists: the
 * explorer imports them statically, `scripts/prepare-variables.mjs` computes their values
 * for the CSV build, and `pipeline/variables/compute.ts` upserts them into ClickHouse's
 * `eth.variables` catalog before running each formula.
 *
 * Users are a demo list with no authentication behind it; `created_by` is the only thing
 * that refers to them.
 *
 * Shared by the browser (src/), the API (api/) and the node scripts, so it must stay free of
 * both DOM and node imports.
 */

import usersJson from './users.json' with { type: 'json' }
import variablesJson from './variables.json' with { type: 'json' }

export interface User {
  id: string
  name: string
}

/**
 * `transaction`: one value per transaction, keyed by (block_number, transaction_index), and
 * shown on every row of that transaction. The only grain so far.
 */
export type VariableGrain = 'transaction'

/** `flag`: 0 or 1. Room is left for counts and ratios once a variable needs one. */
export type VariableValueType = 'flag'

export interface VariableDefinition {
  /** Also the column name. snake_case, unique, and never one of the dataset's own fields. */
  id: string
  label: string
  description?: string
  tags?: string[]
  /** A `User.id`. */
  created_by: string
  /** ISO date, `YYYY-MM-DD`. */
  created_at: string
  grain: VariableGrain
  value_type: VariableValueType
  /** Bumped whenever the formula changes, so stale computed values can be told apart. */
  version: number
  formula: {
    /** The rule in plain language, for the data dictionary. */
    summary: string
    /** Repo-relative path of the ClickHouse formula that computes it. */
    sql: string
  }
}

export const USERS: User[] = usersJson as User[]
export const VARIABLES: VariableDefinition[] = variablesJson as VariableDefinition[]

const ID_PATTERN = /^[a-z][a-z0-9_]*$/
const TAG_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/
const GRAINS: readonly string[] = ['transaction']
const VALUE_TYPES: readonly string[] = ['flag']

/**
 * Every problem with a registry, as human-readable strings; empty means valid. Returns
 * rather than throws so a test can show all of them at once.
 */
export function validateRegistry(variables: VariableDefinition[], users: User[]): string[] {
  const errors: string[] = []
  const userIds = new Set<string>()
  for (const u of users) {
    if (!u.id || !u.name) errors.push(`user ${JSON.stringify(u)} needs an id and a name`)
    if (userIds.has(u.id)) errors.push(`duplicate user id ${u.id}`)
    userIds.add(u.id)
  }

  const ids = new Set<string>()
  for (const v of variables) {
    const at = `variable ${v.id}`
    if (!ID_PATTERN.test(v.id)) errors.push(`${at}: id must be snake_case`)
    if (ids.has(v.id)) errors.push(`${at}: duplicate id`)
    ids.add(v.id)
    if (!v.label) errors.push(`${at}: label is required`)
    if (!userIds.has(v.created_by)) errors.push(`${at}: unknown creator ${v.created_by}`)
    if (!DATE_PATTERN.test(v.created_at)) errors.push(`${at}: created_at must be YYYY-MM-DD`)
    if (!GRAINS.includes(v.grain)) errors.push(`${at}: unknown grain ${v.grain}`)
    if (!VALUE_TYPES.includes(v.value_type)) errors.push(`${at}: unknown value_type ${v.value_type}`)
    if (!Number.isInteger(v.version) || v.version < 1) errors.push(`${at}: version must be a positive integer`)
    if (!v.formula?.summary || !v.formula?.sql) errors.push(`${at}: formula needs a summary and a sql path`)
    for (const tag of v.tags ?? []) {
      if (!TAG_PATTERN.test(tag)) errors.push(`${at}: tag "${tag}" must be lowercase kebab-case`)
    }
  }
  return errors
}

const usersById = new Map(USERS.map((u) => [u.id, u]))
const variablesById = new Map(VARIABLES.map((v) => [v.id, v]))

export function getUser(id: string): User | undefined {
  return usersById.get(id)
}

export function getVariable(id: string): VariableDefinition | undefined {
  return variablesById.get(id)
}

/**
 * Up to two initials for a user's avatar: first and last word of the name ("Nir Chemaya"
 * -> "NC"), or the first letter of a one-word name.
 */
export function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean)
  if (words.length === 0) return '?'
  const first = words[0][0]
  const last = words.length > 1 ? words[words.length - 1][0] : ''
  return (first + last).toUpperCase()
}

/** The variable's creator, falling back to the bare id if the user list doesn't know them. */
export function resolveCreator(variable: VariableDefinition): User {
  return getUser(variable.created_by) ?? { id: variable.created_by, name: variable.created_by }
}

/**
 * Registry search, for the API today and the variable browser later: every given criterion
 * must match. `tag` is an exact tag; `q` is a case-insensitive substring of the id, label,
 * description or any tag; `createdBy` is a user id.
 */
export function searchVariables(
  variables: VariableDefinition[],
  criteria: { tag?: string; q?: string; createdBy?: string },
): VariableDefinition[] {
  const q = criteria.q?.trim().toLowerCase()
  return variables.filter((v) => {
    if (criteria.tag && !(v.tags ?? []).includes(criteria.tag)) return false
    if (criteria.createdBy && v.created_by !== criteria.createdBy) return false
    if (q) {
      const haystack = [v.id, v.label, v.description ?? '', ...(v.tags ?? [])].join(' ').toLowerCase()
      if (!haystack.includes(q)) return false
    }
    return true
  })
}
