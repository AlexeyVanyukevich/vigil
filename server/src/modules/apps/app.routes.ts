import type { FastifyInstance } from 'fastify'
import { listApps } from './app.repository.js'

export function registerApps(app: FastifyInstance): void {
  // Read by the issues screen to fill its filter. Behind the session guard like everything
  // under /api: an ingest key must never be able to enumerate the applications vigil watches.
  app.get('/api/apps', async () => ({ apps: await listApps(app.db) }))
}
