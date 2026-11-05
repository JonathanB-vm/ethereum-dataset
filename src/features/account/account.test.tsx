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

// The API's schema for the builder and column browser: the live types of two tables.
const SCHEMA_TABLES = [
  {
    name: 'transactions',
    label: 'Transactions',
    description: 'One row per transaction.',
    columns: [
      { name: 'block_number', type: 'UInt32', kind: 'number', nullable: false, description: 'Block the transaction is in.' },
      { name: 'value', type: 'UInt256', kind: 'bignum', nullable: false, description: 'ETH sent with the transaction.', unit: 'wei' },
      { name: 'gas', type: 'UInt64', kind: 'number', nullable: false, description: 'Gas limit the sender set.' },
    ],
  },
  {
    name: 'token_transfers',
    label: 'Token transfers',
    description: 'One row per transfer.',
    columns: [{ name: 'event_type', type: 'LowCardinality(String)', kind: 'enum', nullable: false, description: 'Token standard.' }],
  },
]

const modalRoutes = (extra: Record<string, Handler> = {}) => ({
  'GET /v1/variable-requests/schema': () => ({ json: { tables: SCHEMA_TABLES } }),
  'GET /v1/variable-requests/template': () => ({ json: { query_sql: 'SELECT block_number, transaction_index, 1 AS value' } }),
  ...extra,
})

describe('ProposeVariableModal', () => {
  it('builds a flag from a column picked in the list, shows it in words and SQL, and submits it', async () => {
    const calls = fakeApi(
      modalRoutes({
        'POST /v1/variable-requests/estimate': () => ({ json: { estimate: ESTIMATE } }),
        'POST /v1/variable-requests': () => ({ status: 201, json: { request: pending } }),
      }),
    )
    const onSubmitted = vi.fn()
    render(<ProposeVariableModal onClose={vi.fn()} onSubmitted={onSubmitted} />)

    // Clicking a column in the browser adds a condition on it.
    fireEvent.click(await screen.findByRole('button', { name: 'Add a condition on: transactions.value' }))
    fireEvent.change(screen.getByRole('combobox', { name: 'Condition operator' }), { target: { value: 'gt' } })
    fireEvent.change(screen.getByRole('textbox', { name: 'Value for value' }), { target: { value: '1' } })

    expect(screen.getByText("1 if the transaction's value is greater than 1 ETH, otherwise 0.")).toBeInTheDocument()
    expect(screen.getByLabelText('Generated SQL')).toHaveTextContent("toUInt8(value > toUInt256('1000000000000000000')) AS value")

    fireEvent.click(screen.getByRole('button', { name: 'Estimate cost' }))
    expect(await screen.findByText(/Moderate/)).toBeInTheDocument()

    fireEvent.change(screen.getByRole('textbox', { name: 'Column name' }), { target: { value: 'big_sender' } })
    fireEvent.change(screen.getByRole('textbox', { name: 'Label' }), { target: { value: 'Big Sender' } })
    fireEvent.click(screen.getByRole('button', { name: 'Use as description' }))
    fireEvent.click(screen.getByRole('button', { name: 'Submit request' }))

    await waitFor(() => expect(onSubmitted).toHaveBeenCalled())
    const submitted = calls.find((c) => c.key === 'POST /v1/variable-requests')?.body as Record<string, string>
    expect(submitted).toMatchObject({
      variable_id: 'big_sender',
      value_type: 'flag',
      description: "1 if the transaction's value is greater than 1 ETH, otherwise 0.",
    })
    expect(submitted.query_sql).toContain('FROM transactions')
    expect(calls.find((c) => c.key === 'POST /v1/variable-requests/estimate')?.body).toEqual({ query_sql: submitted.query_sql })
  })

  it('says what is missing before submitting an incomplete build', async () => {
    const calls = fakeApi(modalRoutes())
    render(<ProposeVariableModal onClose={vi.fn()} onSubmitted={vi.fn()} />)
    await screen.findByRole('button', { name: 'Add condition' })
    fireEvent.change(screen.getByRole('textbox', { name: 'Column name' }), { target: { value: 'x_flag' } })
    fireEvent.change(screen.getByRole('textbox', { name: 'Label' }), { target: { value: 'X' } })
    fireEvent.click(screen.getByRole('button', { name: 'Submit request' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Add at least one condition')
    expect(calls.some((c) => c.key === 'POST /v1/variable-requests')).toBe(false)
  })

  it('carries a built query to the SQL editor, where picking a column inserts its name', async () => {
    fakeApi(modalRoutes())
    render(<ProposeVariableModal onClose={vi.fn()} onSubmitted={vi.fn()} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Add a condition on: transactions.gas' }))
    fireEvent.change(screen.getByRole('combobox', { name: 'Condition operator' }), { target: { value: 'gt' } })
    fireEvent.change(screen.getByRole('textbox', { name: 'Value for gas' }), { target: { value: '100000' } })
    fireEvent.click(screen.getByRole('button', { name: 'Edit as SQL' }))

    const editor = screen.getByRole('textbox', { name: 'Query SQL' }) as HTMLTextAreaElement
    expect(editor.value).toContain('toUInt8(gas > 100000) AS value')
    editor.setSelectionRange(0, 0)
    fireEvent.click(screen.getByRole('button', { name: 'Insert: transactions.block_number' }))
    expect(editor.value.startsWith('block_numberSELECT')).toBe(true)
  })

  it('lists every validation problem the server reports for hand-written SQL', async () => {
    fakeApi(
      modalRoutes({
        'POST /v1/variable-requests/estimate': () => ({
          status: 400,
          json: { message: 'the query is not valid', details: ['only one statement is allowed', 'the query must filter on {block_from:UInt32} and {block_to:UInt32}'] },
        }),
      }),
    )
    render(<ProposeVariableModal onClose={vi.fn()} onSubmitted={vi.fn()} />)
    fireEvent.click(await screen.findByRole('tab', { name: 'SQL' }))
    await waitFor(() => expect(screen.getByRole('textbox', { name: 'Query SQL' })).toHaveValue('SELECT block_number, transaction_index, 1 AS value'))
    fireEvent.click(screen.getByRole('button', { name: 'Estimate cost' }))
    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('the query is not valid')
    expect(within(alert).getAllByRole('listitem')).toHaveLength(2)
  })

  it('filters the column list by name or meaning', async () => {
    fakeApi(modalRoutes())
    render(<ProposeVariableModal onClose={vi.fn()} onSubmitted={vi.fn()} />)
    await screen.findByRole('button', { name: 'Add a condition on: transactions.value' })
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search columns' }), { target: { value: 'gas limit' } })
    expect(screen.getByRole('button', { name: 'Add a condition on: transactions.gas' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Add a condition on: transactions.value' })).not.toBeInTheDocument()
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
