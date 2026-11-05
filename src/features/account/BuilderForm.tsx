import {
  needsValue,
  newCondition,
  numericColumns,
  OPERATOR_LABEL,
  operatorsFor,
  OUTPUTS,
  SOURCE_LABEL,
  type AmountUnit,
  type BuilderState,
  type Condition,
  type Source,
  type SchemaTable,
} from './queryBuilder'

interface Props {
  schema: SchemaTable[]
  state: BuilderState
  onChange: (state: BuilderState) => void
}

const UNITS: { unit: AmountUnit; label: string }[] = [
  { unit: 'eth', label: 'ETH' },
  { unit: 'gwei', label: 'Gwei' },
  { unit: 'wei', label: 'wei' },
]

/**
 * The "Build" tab: three choices, in the order a researcher thinks of them — which rows,
 * what the value is, which conditions. The SQL is written from these (queryBuilder.ts).
 */
export function BuilderForm({ schema, state, onChange }: Props) {
  const table = schema.find((t) => t.name === state.source)
  const set = (patch: Partial<BuilderState>) => onChange({ ...state, ...patch })
  const outputs = OUTPUTS[state.source]
  const output = outputs.find((o) => o.output === state.output) ?? outputs[0]
  const valueColumns = numericColumns(table)
  const valueColumn = valueColumns.find((c) => c.name === state.valueColumn)

  const chooseSource = (source: Source) => {
    if (source === state.source) return
    // Conditions name columns of the old table; carry over the ones the new table also has.
    const columns = new Set(schema.find((t) => t.name === source)?.columns.map((c) => c.name))
    onChange({
      ...state,
      source,
      output: OUTPUTS[source].some((o) => o.output === state.output) ? state.output : 'flag',
      valueColumn: columns.has(state.valueColumn) ? state.valueColumn : '',
      conditions: state.conditions.filter((c) => columns.has(c.column)),
    })
  }

  const updateCondition = (id: string, patch: Partial<Condition>) =>
    set({ conditions: state.conditions.map((c) => (c.id === id ? { ...c, ...patch } : c)) })

  const chooseColumn = (id: string, name: string) => {
    const column = table?.columns.find((c) => c.name === name)
    const current = state.conditions.find((c) => c.id === id)
    const ops = column ? operatorsFor(column) : []
    updateCondition(id, { column: name, op: current && ops.includes(current.op) ? current.op : (ops[0] ?? 'eq') })
  }

  return (
    <div className="qb">
      <fieldset className="qb-step">
        <legend className="qb-step__label">Compute it from</legend>
        <div className="qb-segment" role="radiogroup" aria-label="Compute it from">
          {(Object.keys(SOURCE_LABEL) as Source[]).map((s) => (
            <button
              key={s}
              type="button"
              role="radio"
              aria-checked={state.source === s}
              className={`qb-segment__btn${state.source === s ? ' qb-segment__btn--on' : ''}`}
              onClick={() => chooseSource(s)}
            >
              {SOURCE_LABEL[s]}
              <span className="qb-segment__hint">{s === 'transactions' ? 'one row per transaction' : 'combined per transaction'}</span>
            </button>
          ))}
        </div>
      </fieldset>

      <fieldset className="qb-step">
        <legend className="qb-step__label">The value is</legend>
        <div className="qb-segment" role="radiogroup" aria-label="The value is">
          {outputs.map((o) => (
            <button
              key={o.output}
              type="button"
              role="radio"
              aria-checked={output.output === o.output}
              className={`qb-segment__btn${output.output === o.output ? ' qb-segment__btn--on' : ''}`}
              onClick={() => set({ output: o.output })}
            >
              {o.label}
            </button>
          ))}
        </div>
        <p className="qb-step__hint">{output.hint}</p>
        {(output.output === 'sum' || output.output === 'column') && (
          <div className="qb-inline">
            <label className="qb-inline__field">
              <span>{output.output === 'sum' ? 'Sum of' : 'Column'}</span>
              <select
                className="acct-input"
                value={state.valueColumn}
                onChange={(e) => set({ valueColumn: e.target.value })}
                aria-label={output.output === 'sum' ? 'Column to sum' : 'Column to read'}
              >
                <option value="">Choose a numeric column…</option>
                {valueColumns.map((c) => (
                  <option key={c.name} value={c.name}>
                    {c.name}
                  </option>
                ))}
              </select>
            </label>
            {valueColumn?.unit === 'wei' && (
              <label className="qb-inline__field qb-inline__field--narrow">
                <span>in</span>
                <select
                  className="acct-input"
                  value={state.valueUnit}
                  onChange={(e) => set({ valueUnit: e.target.value as AmountUnit })}
                  aria-label="Unit of the value"
                >
                  {UNITS.map((u) => (
                    <option key={u.unit} value={u.unit}>
                      {u.label}
                    </option>
                  ))}
                </select>
              </label>
            )}
          </div>
        )}
      </fieldset>

      <fieldset className="qb-step">
        <legend className="qb-step__label">
          {state.source === 'token_transfers' ? 'For transfers where' : 'When'}
          {state.conditions.length > 1 && (
            <span className="qb-match">
              <button
                type="button"
                className={`qb-match__btn${state.match === 'all' ? ' qb-match__btn--on' : ''}`}
                aria-pressed={state.match === 'all'}
                onClick={() => set({ match: 'all' })}
              >
                all
              </button>
              <button
                type="button"
                className={`qb-match__btn${state.match === 'any' ? ' qb-match__btn--on' : ''}`}
                aria-pressed={state.match === 'any'}
                onClick={() => set({ match: 'any' })}
              >
                any
              </button>
              <span>of these match</span>
            </span>
          )}
        </legend>
        {state.conditions.length === 0 && (
          <p className="qb-step__hint">
            {output.output === 'flag'
              ? 'Add a condition. Picking a column in the list on the right adds one too.'
              : 'Optional. Without conditions every row counts.'}
          </p>
        )}
        <ul className="qb-conditions">
          {state.conditions.map((c) => {
            const column = table?.columns.find((col) => col.name === c.column)
            const ops = column ? operatorsFor(column) : []
            return (
              <li key={c.id} className="qb-cond">
                <select className="acct-input acct-input--mono" value={c.column} onChange={(e) => chooseColumn(c.id, e.target.value)} aria-label="Condition column">
                  <option value="">Column…</option>
                  {table?.columns.map((col) => (
                    <option key={col.name} value={col.name}>
                      {col.name}
                    </option>
                  ))}
                </select>
                <select
                  className="acct-input"
                  value={c.op}
                  onChange={(e) => updateCondition(c.id, { op: e.target.value as Condition['op'] })}
                  aria-label="Condition operator"
                  disabled={!column}
                >
                  {ops.map((op) => (
                    <option key={op} value={op}>
                      {OPERATOR_LABEL[op]}
                    </option>
                  ))}
                </select>
                {column && needsValue(c.op) ? (
                  <span className="qb-cond__value">
                    <input
                      className="acct-input acct-input--mono"
                      value={c.value}
                      onChange={(e) => updateCondition(c.id, { value: e.target.value })}
                      placeholder={placeholderFor(column.kind, column.unit)}
                      aria-label={`Value for ${column.name}`}
                    />
                    {column.unit === 'wei' && (
                      <select
                        className="acct-input qb-cond__unit"
                        value={c.unit}
                        onChange={(e) => updateCondition(c.id, { unit: e.target.value as AmountUnit })}
                        aria-label={`Unit for ${column.name}`}
                      >
                        {UNITS.map((u) => (
                          <option key={u.unit} value={u.unit}>
                            {u.label}
                          </option>
                        ))}
                      </select>
                    )}
                  </span>
                ) : (
                  <span />
                )}
                <button
                  type="button"
                  className="acct-icon-btn"
                  aria-label="Remove condition"
                  onClick={() => set({ conditions: state.conditions.filter((x) => x.id !== c.id) })}
                >
                  <svg viewBox="0 0 16 16" width="12" height="12" fill="none" aria-hidden="true">
                    <path d="M3.5 3.5l9 9m0-9l-9 9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                  </svg>
                </button>
              </li>
            )
          })}
        </ul>
        <button type="button" className="acct-btn qb-add" onClick={() => set({ conditions: [...state.conditions, newCondition()] })}>
          Add condition
        </button>
      </fieldset>
    </div>
  )
}

function placeholderFor(kind: string, unit?: 'wei'): string {
  if (unit === 'wei') return '1.5'
  switch (kind) {
    case 'address':
      return '0x… (40 hex digits)'
    case 'hash':
      return '0x… (64 hex digits)'
    case 'datetime':
      return '2026-07-14 23:40:00'
    case 'number':
    case 'bignum':
      return '100000'
    default:
      return 'ERC-20'
  }
}
