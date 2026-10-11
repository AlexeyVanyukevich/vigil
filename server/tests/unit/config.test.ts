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

// Off unless asked for: believing a forwarded address that no proxy of ours wrote lets a client
// name its own address, and with it its own login budget.
interface TrustProxyCase {
  name: string
  value: string | undefined
  expected: string[] | RegExp
}

const REFUSED = /TRUST_PROXY must list the proxy's addresses/

const TRUST_PROXY_CASES: TrustProxyCase[] = [
  { name: 'trusts no proxy when absent', value: undefined, expected: [] },
  { name: 'trusts no proxy when blank', value: '  ', expected: [] },
  { name: 'reads a named range', value: 'loopback', expected: ['loopback'] },
  { name: 'reads an IPv4 address', value: '127.0.0.1', expected: ['127.0.0.1'] },
  { name: 'reads an IPv6 address', value: '::1', expected: ['::1'] },
  {
    name: 'reads a comma-separated list of ranges',
    value: ' 10.0.0.0/8 , fd00::/8,uniquelocal ',
    expected: ['10.0.0.0/8', 'fd00::/8', 'uniquelocal'],
  },
  // `true` is Fastify's trust-every-hop switch, the one setting that lets a client choose its
  // own address. A deployment that writes it must be stopped, not obeyed.
  { name: 'refuses true', value: 'true', expected: REFUSED },
  { name: 'refuses false', value: 'false', expected: REFUSED },
  { name: 'refuses a hop count', value: '1', expected: REFUSED },
  { name: 'refuses a host name', value: 'proxy.internal', expected: REFUSED },
  { name: 'refuses an IPv4 prefix past 32', value: '10.0.0.0/33', expected: REFUSED },
  { name: 'refuses an empty entry', value: 'loopback,', expected: REFUSED },
]

describe('TRUST_PROXY', () => {
  it.each(TRUST_PROXY_CASES)('$name', ({ value, expected }) => {
    const env = value === undefined ? { ...MINIMAL } : { ...MINIMAL, TRUST_PROXY: value }
    if (expected instanceof RegExp) {
      expect(() => loadConfig(env)).toThrow(expected)
    } else {
      expect(loadConfig(env).trustProxy).toEqual(expected)
    }
  })
})
