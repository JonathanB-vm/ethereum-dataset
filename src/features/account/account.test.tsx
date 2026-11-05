import '@testing-library/jest-dom'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AccountButton } from './AccountButton'
import { ProposeVariableModal } from './ProposeVariableModal'
import { RequestsPanel } from './RequestsPanel'
import { formatBytes, formatDuration, type AccountUser, type Estimate, type VariableRequest } from './accountApi'

type Handler = (body: unknown) => { status?: number; json: unknown }

/** A scripted /v1 API: `routes['POST /v1/x']` answers that call; every call is recorded. */
function fakeApi(routes: Record<string, Handler>) {
  const calls: { key: string; body: unknown }[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const key = `${init?.method ?? 'GET'} ${new URL(url, 'http://x').pathname}`
      const body = init?.body ? JSON.parse(String(init.body)) : undefined
      calls.push({ key, body })
      const handler = routes[key]
      if (!handler) return new Response(JSON.stringify({ message: 'not found' }), { status: 404 })
      const { status = 200, json } = handler(body)
      return new Response(JSON.stringify(json), { status })
    }),
  )
  return calls
}

afterEach(() => vi.unstubAllGlobals())

const ESTIMATE: Estimate = {
  samples: [
    { blocks: 50, readRows: 20_000, readBytes: 800_000, resultRows: 20_000, elapsedMs: 4, memoryBytes: 3e6 },
    { blocks: 100, readRows: 40_000, readBytes: 1_600_000, resultRows: 40_000, elapsedMs: 7, memoryBytes: 3e6 },
  ],
  planner: [{ table: 'transactions', rows: 40_642, parts: 1, marks: 5 }],
  loaded: { blocks: 100, readRows: 40_000, readBytes: 1_600_000, resultRows: 40_000, elapsedMs: 7, memoryBytes: 3e6, storageBytes: 160_000 },
  year: { blocks: 2_628_000, readRows: 1.05e9, readBytes: 4.2e10, resultRows: 1.05e9, elapsedMs: 160_000, memoryBytes: 3e6, storageBytes: 4.2e9 },
  tier: 'moderate',
  notes: ['Sample runs take milliseconds.'],
}

const researcher: AccountUser = { id: 'u1', name: 'Ada Lovelace', email: 'ada@x.com', picture_url: '', role: 'researcher' }
const admin: AccountUser = { ...researcher, id: 'a1', name: 'Gal Harel', role: 'admin' }

const pending: VariableRequest = {
  id: 'r1',
  variableId: 'big_sender',
  label: 'Big Sender',
  description: 'Sent more than 1 ETH',
  tags: ['value'],
  valueType: 'flag',
  querySql: 'SELECT block_number, transaction_index, 1 AS value FROM transactions',
  requestedBy: 'u1',
  requestedByName: 'Ada Lovelace',
  status: 'pending',
  estimate: ESTIMATE,
  reviewNote: '',
  reviewedByName: null,
  error: '',
  createdAt: '2026-11-05 10:00:00',
}

describe('ProposeVariableModal', () => {
  it('prefills the query template, shows the measured estimate, and submits the form', async () => {
    const calls = fakeApi({
      'GET /v1/variable-requests/template': () => ({ json: { query_sql: 'SELECT block_number, transaction_index, 1 AS value' } }),
      'POST /v1/variable-requests/estimate': () => ({ json: { estimate: ESTIMATE } }),
      'POST /v1/variable-requests': (body) => ({ status: 201, json: { request: { ...pending, variableId: (body as { variable_id: string }).variable_id } } }),
    })
    const onSubmitted = vi.fn()
    render(<ProposeVariableModal onClose={vi.fn()} onSubmitted={onSubmitted} />)

    const sql = screen.getByRole('textbox', { name: /Query/ })
    await waitFor(() => expect(sql).toHaveValue('SELECT block_number, transaction_index, 1 AS value'))

    fireEvent.click(screen.getByRole('button', { name: 'Estimate cost' }))
    expect(await screen.findByText(/Moderate/)).toBeInTheDocument()
    expect(screen.getByRole('table')).toHaveTextContent('2.6 M blocks')

    fireEvent.change(screen.getByRole('textbox', { name: 'Column name' }), { target: { value: 'big_sender' } })
    fireEvent.change(screen.getByRole('textbox', { name: 'Label' }), { target: { value: 'Big Sender' } })
    fireEvent.change(screen.getByRole('textbox', { name: /Tags/ }), { target: { value: 'value, sender' } })
    fireEvent.click(screen.getByRole('button', { name: 'Submit request' }))

    await waitFor(() => expect(onSubmitted).toHaveBeenCalled())
    expect(calls.find((c) => c.key === 'POST /v1/variable-requests')?.body).toMatchObject({
      variable_id: 'big_sender',
      label: 'Big Sender',
      tags: ['value', 'sender'],
      value_type: 'flag',
    })
  })

  it('lists every validation problem the server reports', async () => {
    fakeApi({
      'GET /v1/variable-requests/template': () => ({ json: { query_sql: 'SELECT 1' } }),
      'POST /v1/variable-requests/estimate': () => ({
        status: 400,
        json: { message: 'the query is not valid', details: ['only one statement is allowed', 'the query must filter on {block_from:UInt32} and {block_to:UInt32}'] },
      }),
    })
    render(<ProposeVariableModal onClose={vi.fn()} onSubmitted={vi.fn()} />)
    await waitFor(() => expect(screen.getByRole('textbox', { name: /Query/ })).toHaveValue('SELECT 1'))
    fireEvent.click(screen.getByRole('button', { name: 'Estimate cost' }))
    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('the query is not valid')
    expect(within(alert).getAllByRole('listitem')).toHaveLength(2)
  })
})

describe('RequestsPanel', () => {
  it('lets an admin read a request and approve it with a note', async () => {
    const calls = fakeApi({
      'GET /v1/variable-requests': () => ({ json: { requests: [pending] } }),
      'POST /v1/variable-requests/r1/approve': () => ({ status: 202, json: { request: { ...pending, status: 'running' } } }),
    })
    render(<RequestsPanel user={admin} mode="review" onClose={vi.fn()} onVariableAdded={vi.fn()} />)
    fireEvent.click(await screen.findByRole('button', { name: /Big Sender/ }))
    expect(screen.getByText(pending.querySql)).toBeInTheDocument()
    fireEvent.change(screen.getByRole('textbox', { name: 'Review note' }), { target: { value: 'nice' } })
    fireEvent.click(screen.getByRole('button', { name: /Approve/ }))
    expect(await screen.findByText('Computing…')).toBeInTheDocument()
    expect(calls.find((c) => c.key === 'POST /v1/variable-requests/r1/approve')?.body).toEqual({ note: 'nice' })
  })

  it('shows a researcher their own requests without review controls', async () => {
    const calls = fakeApi({ 'GET /v1/variable-requests': () => ({ json: { requests: [pending] } }) })
    render(<RequestsPanel user={researcher} mode="mine" onClose={vi.fn()} onVariableAdded={vi.fn()} />)
    fireEvent.click(await screen.findByRole('button', { name: /Big Sender/ }))
    expect(screen.queryByRole('button', { name: /Approve/ })).not.toBeInTheDocument()
    expect(screen.getByText('Pending review')).toBeInTheDocument()
    expect(calls[0].key).toBe('GET /v1/variable-requests')
  })

  it('tells the explorer once when a running approval finishes, so the new column loads', async () => {
    let status: VariableRequest['status'] = 'running'
    fakeApi({ 'GET /v1/variable-requests': () => ({ json: { requests: [{ ...pending, status }] } }) })
    const onVariableAdded = vi.fn()
    render(<RequestsPanel user={admin} mode="review" onClose={vi.fn()} onVariableAdded={onVariableAdded} pollMs={20} />)
    expect(await screen.findByText('Computing…')).toBeInTheDocument()
    expect(onVariableAdded).not.toHaveBeenCalled()
    status = 'completed'
    expect(await screen.findByText('Added')).toBeInTheDocument()
    expect(onVariableAdded).toHaveBeenCalledTimes(1)
  })
})

describe('AccountButton', () => {
  it('renders nothing when the API is unreachable', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new Error('offline'))))
    const { container } = render(<AccountButton onVariableAdded={vi.fn()} />)
    await waitFor(() => expect(fetch).toHaveBeenCalled())
    expect(container).toBeEmptyDOMElement()
  })

  it('signs in with dev login, then shows the initials and a role-aware menu', async () => {
    fakeApi({
      'GET /v1/auth/config': () => ({ json: { google_client_id: null, dev_login: true } }),
      'GET /v1/auth/me': () => ({ json: { user: null } }),
      'POST /v1/auth/dev': () => ({ json: { user: admin } }),
    })
    render(<AccountButton onVariableAdded={vi.fn()} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Sign in' }))
    const dialog = screen.getByRole('dialog', { name: 'Sign in' })
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Email' }), { target: { value: 'gal@x.com' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Sign in with email' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())

    const avatar = await screen.findByRole('button', { name: 'Account: Gal Harel' })
    expect(avatar).toHaveTextContent('GH')
    fireEvent.click(avatar)
    expect(screen.getByRole('menuitem', { name: 'Review requests' })).toBeInTheDocument()
    expect(screen.getByRole('menuitem', { name: 'Propose a variable…' })).toBeInTheDocument()
  })

  it('shows the typed name as initials on the preview column, and offers Google when configured', async () => {
    fakeApi({
      'GET /v1/auth/config': () => ({ json: { google_client_id: 'cid.apps.googleusercontent.com', dev_login: true } }),
      'GET /v1/auth/me': () => ({ json: { user: null } }),
    })
    render(<AccountButton onVariableAdded={vi.fn()} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Sign in' }))
    const dialog = screen.getByRole('dialog', { name: 'Sign in' })
    expect(within(dialog).getByText('You')).toBeInTheDocument()
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Name' }), { target: { value: 'Nir Chemaya' } })
    expect(within(dialog).getByText('NC')).toBeInTheDocument()
    // Google's script mounts its button here; the divider separates it from email sign-in.
    expect(within(dialog).getByRole('separator')).toHaveTextContent('or')
    expect(document.querySelector('script[data-gsi]')).not.toBeNull()
  })

  it('reports a failed sign-in in the card and keeps it open', async () => {
    fakeApi({
      'GET /v1/auth/config': () => ({ json: { google_client_id: null, dev_login: true } }),
      'GET /v1/auth/me': () => ({ json: { user: null } }),
      'POST /v1/auth/dev': () => ({ status: 403, json: { message: 'this Google account has no verified email' } }),
    })
    render(<AccountButton onVariableAdded={vi.fn()} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Sign in' }))
    const dialog = screen.getByRole('dialog', { name: 'Sign in' })
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Email' }), { target: { value: 'x@y.com' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Sign in with email' }))
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('no verified email')
    expect(screen.getByRole('dialog', { name: 'Sign in' })).toBeInTheDocument()
  })

  it('hides the review queue from a researcher', async () => {
    fakeApi({
      'GET /v1/auth/config': () => ({ json: { google_client_id: null, dev_login: false } }),
      'GET /v1/auth/me': () => ({ json: { user: researcher } }),
    })
    render(<AccountButton onVariableAdded={vi.fn()} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Account: Ada Lovelace' }))
    expect(screen.queryByRole('menuitem', { name: 'Review requests' })).not.toBeInTheDocument()
  })
})

describe('estimate formatting', () => {
  it('scales durations and sizes to readable units', () => {
    expect(formatDuration(0.2)).toBe('1 ms')
    expect(formatDuration(4_500)).toBe('4.5 s')
    expect(formatDuration(160_000)).toBe('3 min')
    expect(formatDuration(3 * 3600_000)).toBe('3.0 h')
    expect(formatBytes(512)).toBe('512 B')
    expect(formatBytes(4.2e9)).toBe('3.9 GB')
  })
})

describe('parseApiUrl', () => {
  it('accepts a same-origin path or an http(s) URL, and ignores anything else', async () => {
    const { parseApiUrl } = await import('./accountApi')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(parseApiUrl('/api')).toBe('/api')
    expect(parseApiUrl('https://api.example.com/')).toBe('https://api.example.com')
    expect(parseApiUrl(undefined)).toBeUndefined()
    // What Git Bash turns `/api` into.
    expect(parseApiUrl('C:/Program Files/Git/api')).toBeUndefined()
    expect(warn).toHaveBeenCalledOnce()
    warn.mockRestore()
  })
})
