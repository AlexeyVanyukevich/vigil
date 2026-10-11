import { isIP } from 'node:net'

export interface Config {
  databaseUrl: string
  port: number
  sessionTtlDays: number
  /**
   * Login attempts allowed per minute per IP. Configurable because it is the only way to
   * exercise the limit in a test without making every other test race it.
   */
  loginAttemptsPerMinute: number
  logLevel: string
  /** §6 hard caps. Configurable so the suite can exercise them without 100-event bodies. */
  maxEventsPerBatch: number
  maxStackBytes: number
  maxContextBytes: number
  /**
   * The addresses of the reverse proxy in front, whose `X-Forwarded-For` is believed: IPs, CIDR
   * ranges, or the named ranges `loopback`, `linklocal` and `uniquelocal`. Empty means none, and
   * then behind a proxy every client has the proxy's address and shares one login budget.
   */
  trustProxy: string[]
}

function required(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key]
  if (value === undefined || value.trim() === '') {
    throw new Error(`Invalid configuration: ${key} is required`)
  }
  return value.trim()
}

function positiveInt(env: NodeJS.ProcessEnv, key: string, fallback: number): number {
  const raw = env[key]?.trim()
  if (raw === undefined || raw === '') return fallback
  const value = Number(raw)
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`Invalid configuration: ${key} must be a positive integer, got "${raw}"`)
  }
  return value
}

const NAMED_RANGES = new Set(['loopback', 'linklocal', 'uniquelocal'])

function isProxyAddress(entry: string): boolean {
  if (NAMED_RANGES.has(entry) || isIP(entry) !== 0) return true
  const [address = '', prefix, ...rest] = entry.split('/')
  if (prefix === undefined || rest.length > 0 || !/^\d{1,3}$/.test(prefix)) return false
  const family = isIP(address)
  return family !== 0 && Number(prefix) <= (family === 4 ? 32 : 128)
}

/**
 * A list of addresses rather than a switch, because the switch Fastify offers is the wrong one:
 * `true` trusts every hop and takes the left-most forwarded address, which the client writes
 * itself, and a hop count trusts nothing at all in the Fastify this runs on. Naming the proxy
 * means the client is the last address it appended, whatever the client sent before it.
 */
function proxyAddresses(env: NodeJS.ProcessEnv, key: string): string[] {
  const raw = env[key]?.trim()
  if (raw === undefined || raw === '') return []
  const entries = raw.split(',').map((entry) => entry.trim())
  const invalid = entries.find((entry) => !isProxyAddress(entry))
  if (invalid !== undefined) {
    throw new Error(
      `Invalid configuration: ${key} must list the proxy's addresses (an IP, a CIDR range, ` +
        `loopback, linklocal or uniquelocal), got "${invalid}"`,
    )
  }
  return entries
}

export function loadConfig(env: NodeJS.ProcessEnv): Config {
  return {
    databaseUrl: required(env, 'DATABASE_URL'),
    port: positiveInt(env, 'PORT', 4_100),
    sessionTtlDays: positiveInt(env, 'SESSION_TTL_DAYS', 30),
    loginAttemptsPerMinute: positiveInt(env, 'LOGIN_ATTEMPTS_PER_MINUTE', 10),
    logLevel: env.LOG_LEVEL?.trim() || 'info',
    maxEventsPerBatch: positiveInt(env, 'MAX_EVENTS_PER_BATCH', 100),
    maxStackBytes: positiveInt(env, 'MAX_STACK_BYTES', 16_384),
    maxContextBytes: positiveInt(env, 'MAX_CONTEXT_BYTES', 8_192),
    trustProxy: proxyAddresses(env, 'TRUST_PROXY'),
  }
}
