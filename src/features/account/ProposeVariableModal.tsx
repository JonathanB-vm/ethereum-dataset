import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { accountApi, ApiError, type Estimate, type RequestDraft, type VariableRequest } from './accountApi'
import { Dialog } from './Dialog'
import { EstimateView } from './EstimateView'
import { BuilderForm } from './BuilderForm'
import { SchemaBrowser } from './SchemaBrowser'
import {
  buildQuery,
  INITIAL_BUILDER,
  newCondition,
  operatorsFor,
  type BuilderState,
  type SchemaColumn,
  type SchemaTable,
  type Source,
} from './queryBuilder'

interface Props {
  onClose: () => void
  onSubmitted: (request: VariableRequest) => void
}

type Mode = 'build' | 'sql'

interface Fields {
  variable_id: string
  label: string
  description: string
  tags: string
  value_type: 'flag' | 'number'
}

const EMPTY: Fields = { variable_id: '', label: '', description: '', tags: '', value_type: 'flag' }

/**
 * A researcher's proposal for a new column: what it means, and the query that computes it.
 *
 * The query can be built (pick a table, what the value is, and conditions from the column
 * list) or written as SQL; "Edit as SQL" carries a built query over to the editor, and
 * the column list beside both is always in reach. Submitting creates a pending request;
 * nothing is computed until an admin approves it. "Estimate cost" validates the query and
 * measures it on a small sample, read-only, so problems surface here.
 */
export function ProposeVariableModal({ onClose, onSubmitted }: Props) {
  const [fields, setFields] = useState<Fields>(EMPTY)
  const [mode, setMode] = useState<Mode>('build')
  const [builder, setBuilder] = useState<BuilderState>(INITIAL_BUILDER)
  const [sql, setSql] = useState('')
  const [schema, setSchema] = useState<SchemaTable[] | null>(null)
  const [schemaError, setSchemaError] = useState<string | null>(null)
  const [estimate, setEstimate] = useState<Estimate | null>(null)
  const [busy, setBusy] = useState<'estimate' | 'submit' | null>(null)
  const [error, setError] = useState<{ message: string; details: string[] } | null>(null)
  const sqlRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    accountApi
      .schema()
      .then(setSchema)
      .catch((err: unknown) => setSchemaError(err instanceof Error ? err.message : String(err)))
    accountApi
      .template()
      .then((t) => setSql((current) => current || t))
      .catch(() => {})
  }, [])

  const built = useMemo(() => (schema ? buildQuery(builder, schema) : null), [builder, schema])
  const querySql = mode === 'build' ? (built?.ok ? built.sql : '') : sql
  const valueType = mode === 'build' && built?.ok ? built.valueType : fields.value_type

  // The measured cost belongs to one exact query; any change makes it stale.
  useEffect(() => setEstimate(null), [querySql])

  const set = <K extends keyof Fields>(key: K, value: Fields[K]) => setFields((f) => ({ ...f, [key]: value }))

  const draft = (): RequestDraft => ({
    variable_id: fields.variable_id,
    label: fields.label,
    description: fields.description,
    tags: fields.tags
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean),
    value_type: valueType,
    query_sql: querySql,
  })

  const fail = (err: unknown) =>
    setError(
      err instanceof ApiError
        ? { message: err.message, details: err.details }
        : { message: err instanceof Error ? err.message : String(err), details: [] },
    )

  async function runEstimate() {
    setBusy('estimate')
    setError(null)
    try {
      setEstimate(await accountApi.estimate({ query_sql: querySql }))
    } catch (err) {
      fail(err)
    } finally {
      setBusy(null)
    }
  }

  async function submit(e: FormEvent) {
    e.preventDefault()
    if (mode === 'build' && built && !built.ok) {
      setError({ message: 'The query isn’t complete yet', details: built.errors })
      return
    }
    setBusy('submit')
    setError(null)
    try {
      onSubmitted(await accountApi.submit(draft()))
    } catch (err) {
      fail(err)
    } finally {
      setBusy(null)
    }
  }

  /** Builder → editor: the built query becomes the starting point for hand edits. */
  function editAsSql() {
    if (built?.ok) {
      setSql(built.sql)
      set('value_type', built.valueType)
    }
    setMode('sql')
  }

  /** A column picked in the list: a new condition in the builder, or its name in the SQL. */
  function pickColumn(table: SchemaTable, column: SchemaColumn) {
    if (mode === 'sql') {
      const el = sqlRef.current
      const start = el?.selectionStart ?? sql.length
      const end = el?.selectionEnd ?? sql.length
      const next = sql.slice(0, start) + column.name + sql.slice(end)
      setSql(next)
      requestAnimationFrame(() => {
        el?.focus()
        el?.setSelectionRange(start + column.name.length, start + column.name.length)
      })
      return
    }
    if (table.name !== 'transactions' && table.name !== 'token_transfers') return
    const source = table.name as Source
    const condition = { ...newCondition(column.name), op: operatorsFor(column)[0] }
    setBuilder((b) =>
      b.source === source
        ? { ...b, conditions: [...b.conditions, condition] }
        : { ...b, source, output: 'flag', valueColumn: '', conditions: [condition] },
    )
  }

  const canEstimate = busy === null && querySql.trim() !== ''

  return (
    <Dialog
      title="Propose a variable"
      onClose={onClose}
      variant="wide"
      footer={
        <>
          <span className="acct-footer__hint">An admin reviews every request before it is computed.</span>
          <button type="button" className="acct-btn" onClick={runEstimate} disabled={!canEstimate}>
            {busy === 'estimate' ? 'Measuring…' : 'Estimate cost'}
          </button>
          <button type="submit" form="propose-variable" className="acct-btn acct-btn--primary" disabled={busy !== null}>
            {busy === 'submit' ? 'Submitting…' : 'Submit request'}
          </button>
        </>
      }
    >
      <div className="propose">
        <form id="propose-variable" className="acct-form propose__main" onSubmit={submit}>
          <div className="acct-form__row">
            <label className="acct-field">
              <span className="acct-field__label">Column name</span>
              <input
                className="acct-input acct-input--mono"
                value={fields.variable_id}
                onChange={(e) => set('variable_id', e.target.value)}
                placeholder="big_sender"
                required
                pattern="[a-z][a-z0-9_]{1,62}"
                title="snake_case: a lowercase letter, then letters, digits or _"
              />
            </label>
            <label className="acct-field">
              <span className="acct-field__label">Label</span>
              <input className="acct-input" value={fields.label} onChange={(e) => set('label', e.target.value)} placeholder="Big Sender" required maxLength={80} />
            </label>
            <label className="acct-field acct-field--narrow">
              <span className="acct-field__label">Value</span>
              <select
                className="acct-input"
                value={valueType}
                onChange={(e) => set('value_type', e.target.value as Fields['value_type'])}
                disabled={mode === 'build'}
                title={mode === 'build' ? 'Set by what you build' : undefined}
              >
                <option value="flag">Flag (0/1)</option>
                <option value="number">Number</option>
              </select>
            </label>
          </div>
          <label className="acct-field">
            <span className="acct-field__label">Description: what the column means and how it is defined</span>
            <textarea className="acct-input" rows={2} value={fields.description} onChange={(e) => set('description', e.target.value)} maxLength={4000} />
          </label>
          <label className="acct-field">
            <span className="acct-field__label">Tags (comma-separated, optional)</span>
            <input className="acct-input" value={fields.tags} onChange={(e) => set('tags', e.target.value)} placeholder="value, sender" />
          </label>

          <section className="propose-query" aria-label="Query">
            <div className="propose-query__tabs" role="tablist" aria-label="How to write the query">
              <button
                type="button"
                role="tab"
                aria-selected={mode === 'build'}
                className={`propose-query__tab${mode === 'build' ? ' propose-query__tab--on' : ''}`}
                onClick={() => setMode('build')}
              >
                Build
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={mode === 'sql'}
                className={`propose-query__tab${mode === 'sql' ? ' propose-query__tab--on' : ''}`}
                onClick={() => setMode('sql')}
              >
                SQL
              </button>
            </div>

            {mode === 'build' ? (
              <div role="tabpanel" aria-label="Build" className="propose-query__panel">
                {schema ? (
                  <BuilderForm schema={schema} state={builder} onChange={setBuilder} />
                ) : (
                  <p className="acct-muted">{schemaError ?? 'Loading tables…'}</p>
                )}
                {built?.ok && (
                  <div className="qb-result">
                    <p className="qb-result__words">
                      <span>In words:</span> {built.summary}
                      {!fields.description.trim() && (
                        <button type="button" className="qb-link" onClick={() => set('description', built.summary)}>
                          Use as description
                        </button>
                      )}
                    </p>
                    <pre className="acct-sql" aria-label="Generated SQL">
                      {built.sql}
                    </pre>
                    <button type="button" className="qb-link" onClick={editAsSql}>
                      Edit as SQL
                    </button>
                  </div>
                )}
              </div>
            ) : (
              <div role="tabpanel" aria-label="SQL" className="propose-query__panel">
                <p className="acct-field__label">
                  One SELECT returning <code>block_number</code>, <code>transaction_index</code>, <code>value</code>, filtered
                  on <code>{'{block_from:UInt32}'}</code> and <code>{'{block_to:UInt32}'}</code>. Click a column on the right
                  to insert it.
                </p>
                <textarea
                  ref={sqlRef}
                  className="acct-input acct-input--mono acct-input--sql"
                  rows={11}
                  spellCheck={false}
                  value={sql}
                  onChange={(e) => setSql(e.target.value)}
                  aria-label="Query SQL"
                />
              </div>
            )}
          </section>

          {error && (
            <div className="acct-error" role="alert">
              <p>{error.message}</p>
              {error.details.length > 0 && (
                <ul>
                  {error.details.map((d) => (
                    <li key={d}>{d}</li>
                  ))}
                </ul>
              )}
            </div>
          )}
          {estimate && <EstimateView estimate={estimate} />}
        </form>

        <aside className="propose__aside">
          <SchemaBrowser
            schema={schema}
            error={schemaError}
            activeTables={mode === 'build' ? ['transactions', 'token_transfers'] : undefined}
            actionLabel={mode === 'build' ? 'Add a condition on' : 'Insert'}
            onPick={pickColumn}
          />
        </aside>
      </div>
    </Dialog>
  )
}
