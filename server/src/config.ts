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
  }
}
