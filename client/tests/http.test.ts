import {
  createServer,
  request,
  type ClientRequest,
  type IncomingMessage,
  type Server,
} from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { toWireEvent } from '../src/payload.js'
import { redact } from '../src/redact.js'

// Real `node:http` objects, not imitations of them: the redactor learns a value is sensitive
// from its key, and these objects keep headers where no key names them — `rawHeaders` as a
// flat array, `_header` as the raw text of the head. `captureError(err, { request })` in a
// Fastify handler hands over exactly these, since `request.raw` is an `IncomingMessage`.
const BEARER = 'tok_4f9a2c7e1b'
const SESSION = 'sess_8d3e6b0a5f'
const SET_COOKIE = 'sid_2c9f7a1e4d'
const LEAKS = [BEARER, SESSION, SET_COOKIE]

let server: Server
const seen: { req?: IncomingMessage; res?: unknown; client?: ClientRequest; reply?: unknown } = {}

beforeAll(async () => {
  server = createServer((req, res) => {
    seen.req = req
    seen.res = res
    res.setHeader('Set-Cookie', `session=${SET_COOKIE}; HttpOnly`)
    res.end('ok')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo

  await new Promise<void>((resolve, reject) => {
    const client = request(
      {
        port,
        host: '127.0.0.1',
        path: '/api/bookings',
        headers: { authorization: `Bearer ${BEARER}`, cookie: `session=${SESSION}` },
      },
      (reply) => {
        seen.reply = reply
        reply.resume()
        reply.on('end', resolve)
      },
    )
    seen.client = client
    client.on('error', reject)
    client.end()
  })
})

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

const cases: Array<{ name: string; payload: () => unknown }> = [
  { name: 'the server-side request', payload: () => redact({ req: seen.req }) },
  { name: 'the server-side response, after it was sent', payload: () => redact({ res: seen.res }) },
  { name: 'the outbound client request', payload: () => redact({ request: seen.client }) },
  { name: 'the response the client received', payload: () => redact({ reply: seen.reply }) },
  {
    name: 'an event whose context is the request',
    payload: () => toWireEvent(new Error('boom'), { req: seen.req }, []),
  },
  {
    name: 'an event whose context is the response',
    payload: () => toWireEvent(new Error('boom'), { res: seen.res }, []),
  },
]

describe('redaction of real node:http objects', () => {
  it('captured every object it is about to redact', () => {
    expect(seen.req?.headers.authorization).toBe(`Bearer ${BEARER}`)
    expect(seen.req?.rawHeaders).toContain(`session=${SESSION}`)
    expect(seen.client).toBeDefined()
    expect(seen.reply).toBeDefined()
  })

  it.each(cases)('sends no credential from $name', ({ payload }) => {
    const json = JSON.stringify(payload())
    for (const leak of LEAKS) expect(json).not.toContain(leak)
  })
})
