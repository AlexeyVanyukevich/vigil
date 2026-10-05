import { resolve } from 'node:path'

/** What the global setup started, for the journeys to find. Written per run, git-ignored. */
export interface Runtime {
  baseURL: string
  ingestKey: string
  password: string
  /** The run's own Testcontainers database, for a journey that has to end a session itself. */
  databaseUrl: string
  /** The owner's application that reports through the real client; see `host.ts`. */
  hostDir: string
}

export const RUNTIME_FILE = resolve(import.meta.dirname, '.runtime.json')
