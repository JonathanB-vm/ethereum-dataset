/**
 * The account and variable-request endpoints of the /v1 API, for the explorer's
 * researcher features. These exist only when the explorer runs against an API
 * (`VITE_API_URL`); the static build never calls them.
 */

/**
 * The API base: a same-origin path (`/api`, proxied by Vite) or an absolute http(s) URL.
 * Anything else is ignored. Git Bash, for one, silently rewrites `VITE_API_URL=/api` into
 * `C:/Program Files/Git/api`, and fetching that fails every request quietly.
 */
export function parseApiUrl(raw: string | undefined): string | undefined {
  if (!raw) return undefined
  if (raw.startsWith('/') || /^https?:\/\//.test(raw)) return raw.replace(/\/$/, '')
  console.warn(`VITE_API_URL=${raw} is not a path or an http(s) URL; account features are off`)
  return undefined
}

import type { SchemaTable } from './queryBuilder'

export const API_URL: string | undefined = parseApiUrl(import.meta.env.VITE_API_URL)

export interface AccountUser {
  id: string
  name: string
  email: string
  picture_url: string
  role: 'researcher' | 'admin'
}

export interface AuthSettings {
  google_client_id: string | null
  dev_login: boolean
}

export interface Projection {
  blocks: number
  readRows: number
  readBytes: number
  resultRows: number
  elapsedMs: number
  memoryBytes: number
  storageBytes: number
}

export interface Estimate {
  samples: {
    blocks: number
    readRows: number
    readBytes: number
    resultRows: number
    elapsedMs: number
    memoryBytes: number
    runs?: number
    elapsedMinMs?: number
    elapsedMaxMs?: number
  }[]
  planner: { table: string; rows: number; parts: number; marks: number }[]
  loaded: Projection
  year: Projection
  tier: 'light' | 'moderate' | 'heavy'
  notes: string[]
}

export type RequestStatus = 'pending' | 'rejected' | 'running' | 'completed' | 'failed'

export interface VariableRequest {
  id: string
  variableId: string
  label: string
  description: string
  tags: string[]
  valueType: 'flag' | 'number'
  querySql: string
  requestedBy: string
  requestedByName: string | null
  status: RequestStatus
  estimate: Estimate | null
  reviewNote: string
  reviewedByName: string | null
  error: string
  createdAt: string
}

export interface RequestDraft {
  variable_id: string
  label: string
  description: string
  tags: string[]
  value_type: 'flag' | 'number'
  query_sql: string
}

/** An API error carrying the server's message and, for validation failures, each problem. */
export class ApiError extends Error {
  readonly status: number
  readonly details: string[]
  constructor(message: string, status: number, details: string[] = []) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.details = details
  }
}

async function call<T>(path: string, init?: { method?: string; body?: unknown }): Promise<T> {
  const res = await fetch(`${API_URL ?? ''}${path}`, {
    method: init?.method ?? 'GET',
    credentials: 'include',
    headers: init?.body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
  })
  const body = (await res.json().catch(() => ({}))) as { message?: string; details?: string[] }
  if (!res.ok) throw new ApiError(body.message ?? `request failed (${res.status})`, res.status, body.details ?? [])
  return body as T
}

export const accountApi = {
  settings: () => call<AuthSettings>('/v1/auth/config'),
  me: () => call<{ user: AccountUser | null }>('/v1/auth/me').then((r) => r.user),
  signInWithGoogle: (credential: string) =>
    call<{ user: AccountUser }>('/v1/auth/google', { method: 'POST', body: { credential } }).then((r) => r.user),
  signInDev: (email: string, name: string) =>
    call<{ user: AccountUser }>('/v1/auth/dev', { method: 'POST', body: { email, name } }).then((r) => r.user),
  signOut: () => call<{ ok: boolean }>('/v1/auth/logout', { method: 'POST', body: {} }),

  template: () => call<{ query_sql: string }>('/v1/variable-requests/template').then((r) => r.query_sql),
  schema: () => call<{ tables: SchemaTable[] }>('/v1/variable-requests/schema').then((r) => r.tables),
  estimate: (draft: Partial<RequestDraft>) =>
    call<{ estimate: Estimate }>('/v1/variable-requests/estimate', { method: 'POST', body: draft }).then((r) => r.estimate),
  submit: (draft: RequestDraft) =>
    call<{ request: VariableRequest }>('/v1/variable-requests', { method: 'POST', body: draft }).then((r) => r.request),
  listRequests: (mine: boolean) =>
    call<{ requests: VariableRequest[] }>(`/v1/variable-requests${mine ? '?mine=1' : ''}`).then((r) => r.requests),
  approve: (id: string, note: string) =>
    call<{ request: VariableRequest }>(`/v1/variable-requests/${id}/approve`, { method: 'POST', body: { note } }).then((r) => r.request),
  reject: (id: string, note: string) =>
    call<{ request: VariableRequest }>(`/v1/variable-requests/${id}/reject`, { method: 'POST', body: { note } }).then((r) => r.request),
}

/** Values plus catalog for a block range, in the shape `parseVariableValues` reads. */
export function variableValuesUrl(blockFrom: number, blockTo: number): string {
  return `${API_URL ?? ''}/v1/variables/values?block_from=${blockFrom}&block_to=${blockTo}`
}

// ---------- formatting for estimates ----------

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.max(1, Math.round(ms))} ms`
  const s = ms / 1000
  if (s < 90) return `${s.toFixed(s < 10 ? 1 : 0)} s`
  const m = s / 60
  if (m < 90) return `${Math.round(m)} min`
  return `${(m / 60).toFixed(1)} h`
}

export function formatBytes(n: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let v = n
  let u = 0
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024
    u++
  }
  return `${v.toFixed(v < 10 && u > 0 ? 1 : 0)} ${units[u]}`
}

export function formatCount(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)} B`
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)} M`
  if (n >= 1e4) return `${(n / 1e3).toFixed(0)} K`
  return Math.round(n).toLocaleString('en-US')
}
