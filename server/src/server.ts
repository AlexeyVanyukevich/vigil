import { buildApp } from './app.js'
import { loadConfig } from './config.js'
import { createDb } from './db/client.js'

const config = loadConfig(process.env)
const db = createDb(config.databaseUrl)
const app = await buildApp({ config, db })

app.addHook('onClose', async () => {
  await db.destroy()
})

try {
  await app.listen({ port: config.port, host: '0.0.0.0' })
} catch (error) {
  app.log.error(error)
  process.exit(1)
}
