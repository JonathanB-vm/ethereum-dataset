import { useCallback, useEffect, useRef, useState } from 'react'
import { accountApi, ApiError, type AccountUser, type VariableRequest } from './accountApi'
import { Dialog } from './Dialog'
import { EstimateView } from './EstimateView'

interface Props {
  user: AccountUser
  /** `review`: every request, with approve and reject (admins). `mine`: the user's own. */
  mode: 'mine' | 'review'
  onClose: () => void
  /** Called when an approval finishes computing, so the explorer can load the new column. */
  onVariableAdded: () => void
  /** How often to refresh while a request is computing. */
  pollMs?: number
}

const STATUS_LABEL: Record<VariableRequest['status'], string> = {
  pending: 'Pending review',
  running: 'Computing…',
  completed: 'Added',
  rejected: 'Rejected',
  failed: 'Failed',
}

/**
 * Variable requests. A researcher sees their own and where each stands; an admin sees the
 * queue, reads the SQL and its measured cost, and approves (which computes the column and
 * adds it) or rejects with a note. Polls while anything is computing.
 */
export function RequestsPanel({ user, mode, onClose, onVariableAdded, pollMs = 1500 }: Props) {
  const [requests, setRequests] = useState<VariableRequest[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [open, setOpen] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      setRequests(await accountApi.listRequests(mode === 'mine'))
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }, [mode])

  useEffect(() => {
    load()
  }, [load])

  // Ids seen computing. A request that later shows up completed — however it got there,
  // poll or not — is a new column, and the explorer is told once.
  const computing = useRef(new Set<string>())
  useEffect(() => {
    if (!requests) return
    let added = false
    for (const r of requests) {
      if (r.status === 'running') computing.current.add(r.id)
      else if (computing.current.delete(r.id) && r.status === 'completed') added = true
    }
    if (added) onVariableAdded()
  }, [requests, onVariableAdded])

  const running = requests?.some((r) => r.status === 'running') ?? false
  useEffect(() => {
    if (!running) return
    const timer = window.setInterval(() => {
      accountApi
        .listRequests(mode === 'mine')
        .then(setRequests)
        .catch(() => {})
    }, pollMs)
    return () => window.clearInterval(timer)
  }, [running, mode, pollMs])

  const title = mode === 'review' ? 'Review variable requests' : 'My variable requests'
  return (
    <Dialog title={title} onClose={onClose} variant="panel">
      {error && <p className="acct-error">{error}</p>}
      {requests === null && !error && <p className="acct-muted">Loading…</p>}
      {requests?.length === 0 && <p className="acct-muted">No requests yet.</p>}
      <ul className="acct-requests">
        {requests?.map((r) => (
          <RequestItem
            key={r.id}
            request={r}
            expanded={open === r.id}
            onToggle={() => setOpen(open === r.id ? null : r.id)}
            canReview={mode === 'review' && user.role === 'admin'}
            onChanged={(updated) => setRequests((list) => list?.map((x) => (x.id === updated.id ? updated : x)) ?? null)}
          />
        ))}
      </ul>
    </Dialog>
  )
}

function RequestItem({
  request: r,
  expanded,
  onToggle,
  canReview,
  onChanged,
}: {
  request: VariableRequest
  expanded: boolean
  onToggle: () => void
  canReview: boolean
  onChanged: (r: VariableRequest) => void
}) {
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function decide(action: 'approve' | 'reject') {
    setBusy(true)
    setError(null)
    try {
      onChanged(await (action === 'approve' ? accountApi.approve(r.id, note) : accountApi.reject(r.id, note)))
    } catch (err) {
      setError(err instanceof ApiError || err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <li className="acct-request">
      <button type="button" className="acct-request__summary" aria-expanded={expanded} onClick={onToggle}>
        <span className="acct-request__name">
          <span className="acct-request__label">{r.label}</span>
          <code>{r.variableId}</code>
        </span>
        <span className={`acct-status acct-status--${r.status}`}>{STATUS_LABEL[r.status]}</span>
      </button>
      <p className="acct-request__meta">
        by {r.requestedByName ?? r.requestedBy} · {r.createdAt}
        {r.estimate && ` · ${r.estimate.tier}`}
      </p>
      {expanded && (
        <div className="acct-request__detail">
          {r.description && <p className="acct-request__description">{r.description}</p>}
          {r.tags.length > 0 && <p className="acct-muted">Tags: {r.tags.join(', ')}</p>}
          <pre className="acct-sql">{r.querySql}</pre>
          {r.estimate && <EstimateView estimate={r.estimate} />}
          {r.reviewNote && (
            <p className="acct-muted">
              Review note{r.reviewedByName ? ` from ${r.reviewedByName}` : ''}: {r.reviewNote}
            </p>
          )}
          {r.error && <p className="acct-error">{r.error}</p>}
          {canReview && r.status === 'pending' && (
            <div className="acct-review">
              <input
                className="acct-input"
                placeholder="Note to the researcher (optional)"
                value={note}
                onChange={(e) => setNote(e.target.value)}
                aria-label="Review note"
              />
              <button type="button" className="acct-btn" onClick={() => decide('reject')} disabled={busy}>
                Reject
              </button>
              <button type="button" className="acct-btn acct-btn--primary" onClick={() => decide('approve')} disabled={busy}>
                Approve &amp; compute
              </button>
            </div>
          )}
          {error && <p className="acct-error">{error}</p>}
        </div>
      )}
    </li>
  )
}
