import { describe, expect, it } from 'vitest'
import { isApiOrIngestPath } from '../../src/app.js'

describe('isApiOrIngestPath', () => {
  it('recognises the API and ingest prefixes', () => {
    expect(isApiOrIngestPath('/api/me')).toBe(true)
    expect(isApiOrIngestPath('/ingest/events')).toBe(true)
  })

  it('leaves the dashboard alone', () => {
    expect(isApiOrIngestPath('/issues/42')).toBe(false)
    expect(isApiOrIngestPath('/')).toBe(false)
  })

  // The bug this guards against: find-my-way percent-decodes a path before routing it, so the
  // not-found handler must decode too, or `/%61pi/nothing` gets the SPA page instead of JSON.
  it('is not fooled by percent-encoding a letter of the prefix', () => {
    expect(isApiOrIngestPath('/%61pi/nothing')).toBe(true)
    expect(isApiOrIngestPath('/%69ngest/events')).toBe(true)
  })

  it('strips the query string before deciding', () => {
    expect(isApiOrIngestPath('/api/me?foo=bar')).toBe(true)
    expect(isApiOrIngestPath('/issues?redirect=/api/me')).toBe(false)
  })

  it('treats an unparseable escape as the literal path rather than throwing', () => {
    expect(() => isApiOrIngestPath('/api/%')).not.toThrow()
    expect(isApiOrIngestPath('/api/%')).toBe(true)
  })
})
