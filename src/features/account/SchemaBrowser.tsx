import { useMemo, useState } from 'react'
import type { ColumnKind, SchemaColumn, SchemaTable } from './queryBuilder'

interface Props {
  schema: SchemaTable[] | null
  error: string | null
  /** Tables whose columns can be used right now (the builder's source); others are dimmed. */
  activeTables?: string[]
  /** What clicking a column does, shown on hover and to screen readers. */
  actionLabel: string
  onPick: (table: SchemaTable, column: SchemaColumn) => void
}

const KIND_LABEL: Record<ColumnKind, string> = {
  number: 'number',
  bignum: 'number',
  address: 'address',
  hash: 'hash',
  enum: 'category',
  text: 'text',
  bool: 'yes / no',
  datetime: 'time',
}

/**
 * Every table and column a variable can be built from, searchable by name or meaning.
 * Clicking a column hands it to the query being written: a new condition in the builder,
 * the name at the cursor in the SQL editor.
 */
export function SchemaBrowser({ schema, error, activeTables, actionLabel, onPick }: Props) {
  const [query, setQuery] = useState('')
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set(['tx_variable_values']))

  const q = query.trim().toLowerCase()
  const filtered = useMemo(
    () =>
      (schema ?? [])
        .map((t) => ({
          table: t,
          columns: q
            ? t.columns.filter((c) => c.name.toLowerCase().includes(q) || c.description.toLowerCase().includes(q))
            : t.columns,
        }))
        .filter((t) => t.columns.length > 0),
    [schema, q],
  )

  const toggle = (name: string) =>
    setCollapsed((s) => {
      const next = new Set(s)
      if (next.has(name)) next.delete(name)
      else next.add(name)
      return next
    })

  return (
    <div className="schema">
      <div className="schema__head">
        <h3 className="schema__title">Columns</h3>
        <input
          className="acct-input schema__search"
          type="search"
          placeholder="Search names or meanings"
          aria-label="Search columns"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>
      <div className="schema__list">
        {error && <p className="acct-error">{error}</p>}
        {!schema && !error && <p className="acct-muted">Loading tables…</p>}
        {schema && filtered.length === 0 && <p className="acct-muted">No column matches “{query}”.</p>}
        {filtered.map(({ table, columns }) => {
          const open = q !== '' || !collapsed.has(table.name)
          const active = !activeTables || activeTables.includes(table.name)
          return (
            <section key={table.name} className={`schema-table${active ? '' : ' schema-table--inactive'}`}>
              <button
                type="button"
                className="schema-table__head"
                aria-expanded={open}
                onClick={() => toggle(table.name)}
              >
                <span className="schema-table__chevron" aria-hidden="true">
                  {open ? '▾' : '▸'}
                </span>
                <span className="schema-table__label">{table.label}</span>
                <code className="schema-table__name">{table.name}</code>
              </button>
              {open && (
                <>
                  <p className="schema-table__description">{table.description}</p>
                  <ul className="schema-table__columns">
                    {columns.map((c) => (
                      <li key={c.name}>
                        <button
                          type="button"
                          className="schema-col"
                          title={`${actionLabel}: ${c.name}`}
                          aria-label={`${actionLabel}: ${table.name}.${c.name}`}
                          onClick={() => onPick(table, c)}
                        >
                          <span className="schema-col__row">
                            <code className="schema-col__name">{c.name}</code>
                            <span className={`schema-col__kind schema-col__kind--${c.kind}`}>
                              {c.unit === 'wei' ? 'amount' : KIND_LABEL[c.kind]}
                            </span>
                          </span>
                          {c.description && <span className="schema-col__description">{c.description}</span>}
                        </button>
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </section>
          )
        })}
      </div>
    </div>
  )
}
