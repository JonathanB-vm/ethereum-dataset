// @vitest-environment node
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  initials,
  resolveCreator,
  searchVariables,
  USERS,
  validateRegistry,
  VARIABLES,
  type VariableDefinition,
} from './registry'

const valid: VariableDefinition = {
  id: 'some_flag',
  label: 'Some Flag',
  created_by: 'nir-chemaya',
  created_at: '2026-11-04',
  grain: 'transaction',
  value_type: 'flag',
  version: 1,
  formula: { summary: 'rule', sql: 'pipeline/variables/some_flag.sql' },
}
const users = [{ id: 'nir-chemaya', name: 'Nir Chemaya' }]

describe('committed registry', () => {
  it('is valid', () => {
    expect(validateRegistry(VARIABLES, USERS)).toEqual([])
  })

  it('credits the first two variables to Nir Chemaya', () => {
    expect(VARIABLES.map((v) => v.id)).toEqual(['simple_transaction', 'from_high_user'])
    for (const v of VARIABLES) expect(resolveCreator(v).name).toBe('Nir Chemaya')
  })

  it('points every variable at a formula file that exists', () => {
    const root = fileURLToPath(new URL('..', import.meta.url))
    for (const v of VARIABLES) {
      expect(fs.existsSync(path.join(root, v.formula.sql)), v.formula.sql).toBe(true)
    }
  })
})

describe('validateRegistry', () => {
  it('accepts a minimal variable', () => {
    expect(validateRegistry([valid], users)).toEqual([])
  })

  it('rejects a non-snake_case id, a duplicate id, an unknown creator and a bad tag', () => {
    const errors = validateRegistry(
      [
        { ...valid, id: 'Bad-Id' },
        valid,
        valid,
        { ...valid, id: 'orphan', created_by: 'nobody' },
        { ...valid, id: 'tagged', tags: ['Not OK'] },
      ],
      users,
    )
    expect(errors).toEqual([
      'variable Bad-Id: id must be snake_case',
      'variable some_flag: duplicate id',
      'variable orphan: unknown creator nobody',
      'variable tagged: tag "Not OK" must be lowercase kebab-case',
    ])
  })

  it('rejects a bad date, version and missing formula', () => {
    const errors = validateRegistry(
      [{ ...valid, created_at: '4/11/2026', version: 0, formula: { summary: '', sql: '' } }],
      users,
    )
    expect(errors).toHaveLength(3)
  })
})

describe('searchVariables', () => {
  it('filters by exact tag, by free text and by creator', () => {
    expect(searchVariables(VARIABLES, { tag: 'rolling-window' }).map((v) => v.id)).toEqual(['from_high_user'])
    expect(searchVariables(VARIABLES, { q: 'TOKEN TRANSFER' }).map((v) => v.id)).toContain('simple_transaction')
    expect(searchVariables(VARIABLES, { createdBy: 'someone-else' })).toEqual([])
    expect(searchVariables(VARIABLES, {})).toHaveLength(VARIABLES.length)
  })
})

describe('initials', () => {
  it('takes the first and last word, uppercased', () => {
    expect(initials('Nir Chemaya')).toBe('NC')
    expect(initials('  ada  b. lovelace ')).toBe('AL')
    expect(initials('Satoshi')).toBe('S')
    expect(initials('')).toBe('?')
  })
})

describe('resolveCreator', () => {
  it('falls back to the bare id for an unknown user', () => {
    expect(resolveCreator({ ...valid, created_by: 'ghost' })).toEqual({ id: 'ghost', name: 'ghost' })
  })
})
