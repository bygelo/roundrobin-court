// The only place the web client talks to the server.
//
// operatorFetch carries the staff session; publicFetch carries nothing and is
// what the portal, the player page, and the display use.

export class ApiError extends Error {
  readonly status: number
  readonly body: unknown
  constructor(status: number, message: string, body: unknown) {
    super(message)
    this.status = status
    this.body = body
  }
}

export type OperatorSession = {
  token: string
  organization_code: string
  actor_code: string
}

const SESSION_KEY = 'court.session'

export function readSession(): OperatorSession | undefined {
  try {
    const raw = window.localStorage.getItem(SESSION_KEY)
    return raw ? (JSON.parse(raw) as OperatorSession) : undefined
  } catch {
    return undefined
  }
}

export function writeSession(session: OperatorSession | undefined) {
  if (session) window.localStorage.setItem(SESSION_KEY, JSON.stringify(session))
  else window.localStorage.removeItem(SESSION_KEY)
}

async function send<T>(path: string, init: RequestInit, token?: string): Promise<T> {
  const header = new Headers(init.headers)
  if (init.body !== undefined && !header.has('content-type')) header.set('content-type', 'application/json')
  if (token) header.set('authorization', `Bearer ${token}`)
  const response = await fetch(path, { ...init, headers: header })
  const text = await response.text()
  let body: unknown = undefined
  if (text) {
    try {
      body = JSON.parse(text)
    } catch {
      body = text
    }
  }
  if (!response.ok) {
    const message =
      body && typeof body === 'object' && 'error' in body && typeof (body as { error: unknown }).error === 'string'
        ? (body as { error: string }).error
        : `Request failed (${response.status})`
    throw new ApiError(response.status, message, body)
  }
  return body as T
}

export const SESSION_EXPIRED = 'court:session-expired'

export async function operatorFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const session = readSession()
  try {
    return await send<T>(path, init, session?.token)
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) {
      writeSession(undefined)
      window.dispatchEvent(new Event(SESSION_EXPIRED))
    }
    throw error
  }
}

export function publicFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  return send<T>(path, init)
}

/** JSON body helper: `post(path, value)` for either fetcher. */
export function jsonBody(value: unknown, method = 'POST'): RequestInit {
  return { method, body: JSON.stringify(value) }
}

export async function signInOperator(input: {
  organization_code: string
  actor_code: string
  secret: string
}): Promise<OperatorSession> {
  const result = await send<{ token: string }>('/api/v1/session', jsonBody(input))
  const session = { token: result.token, organization_code: input.organization_code, actor_code: input.actor_code }
  writeSession(session)
  return session
}
