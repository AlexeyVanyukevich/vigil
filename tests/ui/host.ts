import { spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * A small application of the owner's, written to a directory of its own: it installs the real
 * `@vigil/client` from its own `node_modules`, as a consuming project would, and fails on demand.
 *
 * Its handler is called from inside a dependency, so every stack it reports has the owner's own
 * frame on top and a framework's frames under `node_modules` beneath it — the shape §11 folds.
 */

const ROUTER = `// Stands in for a web framework. The owner's handler runs inside it, so its frames sit
// under node_modules in every stack, as Fastify's or Express's would.
export function dispatch(handler, request) {
  return invoke(handler, request)
}

function invoke(handler, request) {
  return handler(request)
}
`

const BOOKINGS = `export function handleBooking(request) {
  throw new TypeError(request.message)
}
`

// One named function for both modes. The fingerprint reads the top frames, so a crash and a
// handled report must reach the throw by the same path to be one issue.
const SERVER = `import { install } from '@vigil/client/node'
import { dispatch } from 'tiny-router'
import { handleBooking } from './bookings.mjs'

const [mode, message, times = '1'] = process.argv.slice(2)

const vigil = install({
  url: process.env.VIGIL_URL,
  key: process.env.VIGIL_KEY,
  app: 'reference',
  environment: process.env.VIGIL_ENVIRONMENT,
})

function serve() {
  return dispatch(handleBooking, { route: '/api/bookings', message })
}

function tick() {
  if (mode === 'crash') {
    serve()
    return
  }
  for (let i = 0; i < Number(times); i += 1) {
    try {
      serve()
    } catch (error) {
      vigil.captureError(error, { route: '/api/bookings' })
    }
  }
  void vigil.close()
}

// A server's event loop is never idle. Without vigil ending a crashed process, this one would
// run until the journey's own deadline killed it.
if (mode === 'crash') setInterval(() => {}, 1_000)
setTimeout(tick, 10)
`

export const HOST_ENTRY = join('src', 'server.mjs')

export function buildHost(root: string, dir: string): void {
  const client = join(dir, 'node_modules', '@vigil', 'client')
  // The package as it ships: compiled by its own config, run by plain `node`.
  const compiled = spawnSync(
    'npx',
    ['tsc', '-p', join(root, 'client', 'tsconfig.json'), '--outDir', join(client, 'dist')],
    { cwd: root, encoding: 'utf8' },
  )
  if (compiled.status !== 0) {
    throw new Error(`could not compile @vigil/client:\n${compiled.stdout}\n${compiled.stderr}`)
  }
  copyFileSync(join(root, 'client', 'package.json'), join(client, 'package.json'))

  const router = join(dir, 'node_modules', 'tiny-router')
  mkdirSync(router, { recursive: true })
  writeFileSync(
    join(router, 'package.json'),
    JSON.stringify({ name: 'tiny-router', type: 'module', exports: './index.js' }),
  )
  writeFileSync(join(router, 'index.js'), ROUTER)

  mkdirSync(join(dir, 'src'), { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'reference', type: 'module' }))
  writeFileSync(join(dir, 'src', 'bookings.mjs'), BOOKINGS)
  writeFileSync(join(dir, HOST_ENTRY), SERVER)
}
