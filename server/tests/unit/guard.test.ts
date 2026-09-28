import { describe, expect, it } from 'vitest'
import { isApiRoute } from '../../src/modules/auth/guard.js'

describe('isApiRoute', () => {
  it('matches a route under /api/', () => {
    expect(isApiRoute('/api/me')).toBe(true)
  })

  // Nothing registers a route at the exact prefix today, but `startsWith('/api/')` alone would
  // miss one that did — a plugin mounted at exactly `/api` would silently skip both guard hooks.
  it('matches the exact prefix with no trailing slash', () => {
    expect(isApiRoute('/api')).toBe(true)
  })

  it('does not match a route that merely starts with the same letters', () => {
    expect(isApiRoute('/apiary')).toBe(false)
  })

  it('does not match the ingest or dashboard routes', () => {
    expect(isApiRoute('/ingest/events')).toBe(false)
    expect(isApiRoute('/issues/42')).toBe(false)
  })

  // `routeOptions.url` is `undefined` when nothing matched (`request.is404`).
  it('does not match when nothing was routed', () => {
    expect(isApiRoute(undefined)).toBe(false)
  })
})
