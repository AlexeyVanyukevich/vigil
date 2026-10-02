import { afterEach, describe, expect, it, vi } from 'vitest'
import { api, ApiError, NotSignedIn } from '../src/api'

/** What the server, or whatever stands in front of it, answers. `undefined` is a refused connection. */
type Answer = { status: number; body?: string; contentType?: string } | undefined

interface FailureCase {
  name: string
  answer: Answer
  code: string
  status: number
  signedOut: boolean
}

const json = 'application/json; charset=utf-8'

const failures: FailureCase[] = [
  {
    name: 'a refused connection is offline',
    answer: undefined,
    code: 'offline',
    status: 0,
    signedOut: false,
  },
  {
    name: 'a 401 means the session is gone',
    answer: { status: 401, body: '{"error":"unauthorized","message":"x"}', contentType: json },
    code: 'unauthorized',
    status: 401,
    signedOut: true,
  },
  {
    name: 'a JSON error keeps its code',
    answer: { status: 404, body: '{"error":"not_found","message":"x"}', contentType: json },
    code: 'not_found',
    status: 404,
    signedOut: false,
  },
  {
    name: 'a 500 that is not JSON has no code to look up',
    answer: { status: 500, body: 'Internal Server Error', contentType: 'text/plain' },
    code: 'unknown',
    status: 500,
    signedOut: false,
  },
]

function answerWith(answer: Answer): ReturnType<typeof vi.fn> {
  const fetch = vi.fn((_path: string, _init?: RequestInit) =>
    answer === undefined
      ? Promise.reject(new TypeError('Failed to fetch'))
      : Promise.resolve(
          new Response(answer.status === 204 ? null : (answer.body ?? ''), {
            status: answer.status,
            headers: answer.contentType === undefined ? {} : { 'content-type': answer.contentType },
          }),
        ),
  )
  vi.stubGlobal('fetch', fetch)
  return fetch
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('request', () => {
  it.each(failures)('$name', async ({ answer, code, status, signedOut }) => {
    answerWith(answer)

    const failure = await api.get('/api/anything').catch((cause: unknown) => cause)

    expect(failure).toBeInstanceOf(ApiError)
    expect(failure).toMatchObject({ code, status })
    expect(failure instanceof NotSignedIn).toBe(signedOut)
  })

  it('returns the parsed body of a success', async () => {
    answerWith({ status: 200, body: '{"signedIn":true}', contentType: json })
    await expect(api.get('/api/me')).resolves.toEqual({ signedIn: true })
  })

  it('returns nothing for a 204', async () => {
    answerWith({ status: 204 })
    await expect(api.post('/api/logout')).resolves.toBeUndefined()
  })

  it('sends a JSON body only when there is one', async () => {
    const fetch = answerWith({ status: 204 })

    await api.patch('/api/issues/1', { status: 'resolved' })
    await api.post('/api/logout')

    const [, patch] = fetch.mock.calls[0] as [string, RequestInit]
    const [, logout] = fetch.mock.calls[1] as [string, RequestInit]
    expect(patch).toMatchObject({
      method: 'PATCH',
      body: '{"status":"resolved"}',
      headers: { 'content-type': 'application/json' },
    })
    expect(logout.body).toBeUndefined()
    expect(logout.headers).toEqual({})
  })
})
