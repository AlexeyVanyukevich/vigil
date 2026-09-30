import { buildApp } from './app.js'
import { loadConfig } from './config.js'
import { createDb } from './db/client.js'

const config = loadConfig(process.env)
const db = createDb(config.databaseUrl)
const app = await buildApp({ config, db })

// Fastify runs `onClose` hooks in reverse order of registration, so this one runs before the
// drain `buildApp` registered. Drained here as well, explicitly: destroying the pool first would
// fail every self-recorded write still in flight (§13).
app.addHook('onClose', async () => {
  await app.selfRecorder.drain()
  await db.destroy()
})

try {
  await app.listen({ port: config.port, host: '0.0.0.0' })
} catch (error) {
  app.log.error(error)
  process.exit(1)
}
