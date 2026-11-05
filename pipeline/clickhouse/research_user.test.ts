// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { RESEARCH_READABLE_TABLES, researchUserStatements, sqlString } from './research_user.ts'

describe('researchUserStatements', () => {
  const sql = researchUserStatements('eth_research', 'a-long-password-123')

  it('grants SELECT on the dataset tables only, and INSERT only on the values table', () => {
    const grants = sql.filter((s) => s.startsWith('GRANT'))
    expect(grants).toEqual([
      ...RESEARCH_READABLE_TABLES.map((t) => `GRANT SELECT ON eth.${t} TO eth_research`),
      'GRANT INSERT ON eth.tx_variable_values TO eth_research',
    ])
    for (const privateTable of ['users', 'variable_requests', 'variable_runs', 'variables']) {
      expect(grants.join('\n')).not.toMatch(new RegExp(`\\.${privateTable} `))
    }
  })

  it('revokes everything before granting, so a removed grant is removed from the server', () => {
    expect(sql.findIndex((s) => s.startsWith('REVOKE ALL'))).toBeLessThan(sql.findIndex((s) => s.startsWith('GRANT')))
  })

  it('escapes the password and refuses unsafe names or short passwords', () => {
    expect(sqlString("it's a \\ test")).toBe("'it\\'s a \\\\ test'")
    expect(researchUserStatements('u', "pa'ss-word-long")[0]).toContain("'pa\\'ss-word-long'")
    expect(() => researchUserStatements('bad name; DROP', 'a-long-password-123')).toThrow(/user name/)
    expect(() => researchUserStatements('eth_research', 'short')).toThrow(/12 characters/)
  })
})
