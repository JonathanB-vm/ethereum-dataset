import { useEffect, useState, type FormEvent } from 'react'
import { accountApi, ApiError, type Estimate, type RequestDraft, type VariableRequest } from './accountApi'
import { Dialog } from './Dialog'
import { EstimateView } from './EstimateView'

interface Props {
  onClose: () => void
  onSubmitted: (request: VariableRequest) => void
}

const EMPTY: RequestDraft = { variable_id: '', label: '', description: '', tags: [], value_type: 'flag', query_sql: '' }

/**
 * A researcher's proposal for a new column: what it means, and the query that computes it.
 * Submitting creates a pending request; nothing is computed until an admin approves it.
 * "Estimate" validates the query and measures its cost on a small sample, read-only, so
 * problems surface here rather than in the review queue.
 */
export function ProposeVariableModal({ onClose, onSubmitted }: Props) {
  const [draft, setDraft] = useState<RequestDraft>(EMPTY)
  const [tagsText, setTagsText] = useState('')
  const [estimate, setEstimate] = useState<Estimate | null>(null)
  const [busy, setBusy] = useState<'estimate' | 'submit' | null>(null)
  const [error, setError] = useState<{ message: string; details: string[] } | null>(null)

  useEffect(() => {
    accountApi
      .template()
      .then((sql) => setDraft((d) => (d.query_sql ? d : { ...d, query_sql: sql })))
      .catch(() => {})
  }, [])

  const set = <K extends keyof RequestDraft>(key: K, value: RequestDraft[K]) => {
    setDraft((d) => ({ ...d, [key]: value }))
    // A changed query invalidates the measured cost.
    if (key === 'query_sql') setEstimate(null)
  }

  const full = (): RequestDraft => ({
    ...draft,
    tags: tagsText
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean),
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
      setEstimate(await accountApi.estimate({ query_sql: draft.query_sql }))
    } catch (err) {
      fail(err)
    } finally {
      setBusy(null)
    }
  }

  async function submit(e: FormEvent) {
    e.preventDefault()
    setBusy('submit')
    setError(null)
    try {
      onSubmitted(await accountApi.submit(full()))
    } catch (err) {
      fail(err)
    } finally {
      setBusy(null)
    }
  }

  return (
    <Dialog
      title="Propose a variable"
      onClose={onClose}
      footer={
        <>
          <span className="acct-footer__hint">An admin reviews every request before it is computed.</span>
          <button type="button" className="acct-btn" onClick={runEstimate} disabled={busy !== null || !draft.query_sql.trim()}>
            {busy === 'estimate' ? 'Measuring…' : 'Estimate cost'}
          </button>
          <button type="submit" form="propose-variable" className="acct-btn acct-btn--primary" disabled={busy !== null}>
            {busy === 'submit' ? 'Submitting…' : 'Submit request'}
          </button>
        </>
      }
    >
      <form id="propose-variable" className="acct-form" onSubmit={submit}>
        <div className="acct-form__row">
          <label className="acct-field">
            <span className="acct-field__label">Column name</span>
            <input
              className="acct-input acct-input--mono"
              value={draft.variable_id}
              onChange={(e) => set('variable_id', e.target.value)}
              placeholder="big_sender"
              required
              pattern="[a-z][a-z0-9_]{1,62}"
              title="snake_case: a lowercase letter, then letters, digits or _"
            />
          </label>
          <label className="acct-field">
            <span className="acct-field__label">Label</span>
            <input className="acct-input" value={draft.label} onChange={(e) => set('label', e.target.value)} placeholder="Big Sender" required maxLength={80} />
          </label>
          <label className="acct-field acct-field--narrow">
            <span className="acct-field__label">Value</span>
            <select className="acct-input" value={draft.value_type} onChange={(e) => set('value_type', e.target.value as RequestDraft['value_type'])}>
              <option value="flag">Flag (0/1)</option>
              <option value="number">Number</option>
            </select>
          </label>
        </div>
        <label className="acct-field">
          <span className="acct-field__label">Description — what the column means and how it is defined</span>
          <textarea className="acct-input" rows={3} value={draft.description} onChange={(e) => set('description', e.target.value)} maxLength={4000} />
        </label>
        <label className="acct-field">
          <span className="acct-field__label">Tags (comma-separated, optional)</span>
          <input className="acct-input" value={tagsText} onChange={(e) => setTagsText(e.target.value)} placeholder="value, sender" />
        </label>
        <label className="acct-field">
          <span className="acct-field__label">
            Query — one SELECT returning <code>block_number</code>, <code>transaction_index</code>, <code>value</code>, filtered on{' '}
            <code>{'{block_from:UInt32}'}</code> and <code>{'{block_to:UInt32}'}</code>
          </span>
          <textarea
            className="acct-input acct-input--mono acct-input--sql"
            rows={9}
            spellCheck={false}
            value={draft.query_sql}
            onChange={(e) => set('query_sql', e.target.value)}
            required
          />
        </label>
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
    </Dialog>
  )
}
