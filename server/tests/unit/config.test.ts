import { describe, expect, it } from 'vitest'
import { loadConfig } from '../../src/config.js'

const MINIMAL = { DATABASE_URL: 'postgres://localhost/vigil' }

describe('loadConfig', () => {
  it('refuses to start without a database', () => {
    expect(() => loadConfig({})).toThrow(/DATABASE_URL is required/)
  })

  it('fills the §6 caps with the spec defaults', () => {
    const config = loadConfig({ ...MINIMAL })
    expect(config.maxEventsPerBatch).toBe(100)
    expect(config.maxStackBytes).toBe(16_384)
    expect(config.maxContextBytes).toBe(8_192)
  })

  it('applies the remaining defaults', () => {
    const config = loadConfig({ ...MINIMAL })
    expect(config.port).toBe(4100)
    expect(config.sessionTtlDays).toBe(30)
    expect(config.loginAttemptsPerMinute).toBe(10)
    expect(config.logLevel).toBe('info')
  })

  it('reads overrides from the environment', () => {
    const config = loadConfig({ ...MINIMAL, PORT: '4200', MAX_EVENTS_PER_BATCH: '5' })
    expect(config.port).toBe(4200)
    expect(config.maxEventsPerBatch).toBe(5)
  })

  // A typo in deployment should stop the process at start, not surface as a rejected batch
  // the first time an application reports.
  it('refuses a cap that is not a positive integer', () => {
    expect(() => loadConfig({ ...MINIMAL, MAX_STACK_BYTES: '0' })).toThrow(/positive integer/)
    expect(() => loadConfig({ ...MINIMAL, MAX_STACK_BYTES: 'lots' })).toThrow(/positive integer/)
  })

  it('treats a blank value as absent rather than as an empty string', () => {
    expect(() => loadConfig({ DATABASE_URL: '   ' })).toThrow(/DATABASE_URL is required/)
  })
})
