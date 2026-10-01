/**
 * Every call goes to vigil's own server, on the same origin. There is no second backend: an
 * ingest key never reaches a browser in this slice, and the dashboard authenticates with a
 * session cookie it cannot read.
 */

export interface ApiErrorBody {
  error: string
  message: string
  details?: unknown
}

export class ApiError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    message: string,
    readonly details?: unknown,
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

/** Raised on a 401 so the router can show the login screen instead of a broken page. */
export class NotSignedIn extends ApiError {}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  let response: Response
  try {
    response = await fetch(path, {
      ...init,
      // The session cookie is httpOnly; the browser attaches it, nothing here reads it.
      credentials: 'same-origin',
      headers: {
        ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
        ...init.headers,
      },
    })
  } catch {
    throw new ApiError('offline', 0, 'Cannot reach the server.')
  }

  if (response.status === 204) return undefined as T

  const body = (await response.json().catch(() => ({}))) as Partial<ApiErrorBody>

  if (!response.ok) {
    const message = body.message ?? `Error ${response.status}`
    if (response.status === 401) {
      throw new NotSignedIn(body.error ?? 'unauthorized', 401, message)
    }
    throw new ApiError(body.error ?? 'unknown', response.status, message, body.details)
  }

  return body as T
}

export const api = {
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, payload?: unknown) =>
    request<T>(path, {
      method: 'POST',
      ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
    }),
  patch: <T>(path: string, payload: unknown) =>
    request<T>(path, { method: 'PATCH', body: JSON.stringify(payload) }),
}

export type IssueStatus = 'open' | 'resolved' | 'ignored'

export interface IssueSummary {
  id: string
  app_slug: string
  app_name: string
  environment: string
  title: string
  culprit: string | null
  runtime: 'node' | 'browser'
  status: IssueStatus
  first_seen_at: string
  last_seen_at: string
  occurrence_count: number
}

export interface IssueOccurrence {
  id: string
  /** When the application says it happened. */
  occurred_at: string
  /** When vigil stored it. The two differ when an offline queue replayed late. */
  received_at: string
  message: string
  stack: string | null
  context: Record<string, unknown> | null
  count: number
}

export interface AppSummary {
  id: string
  slug: string
  name: string
}
