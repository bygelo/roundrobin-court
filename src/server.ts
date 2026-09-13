// Development and production entry point.
//
// One origin serves the OS, this app's routes, and the built web client, so the
// public portal, the operator console, and the display TVs need no CORS.

import { readFile } from 'node:fs/promises'
import { extname, join } from 'node:path'
import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { createStore, registerModule, withOwner } from '@bygelo/roundrobin-kernel'
import { COURT_DECLARATION, createCourtApp } from './app.ts'
import { startWorker } from './worker.ts'

const database_url = process.env['DATABASE_URL']
if (!database_url) {
  console.error('DATABASE_URL is not set. Refusing to guess a database.')
  process.exit(1)
}

const store = createStore(database_url)

// Registering the catalog on every boot is the intended usage: it is
// idempotent, so a deploy that adds a module or bumps a schema version needs no
// separate step.
await withOwner(store, 'module catalog', (owner) => registerModule(owner, COURT_DECLARATION))

const WEB_ROOT = join(import.meta.dirname, '..', 'dist', 'web')

const CONTENT_TYPE: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.json': 'application/json',
  '.ico': 'image/x-icon',
}

/** Paths the server owns. A missing API route must answer JSON 404, never the web client. */
const SERVER_PREFIX = ['/api/', '/public/', '/output/', '/scan/', '/health', '/docs']

async function readWeb(name: string): Promise<Uint8Array<ArrayBuffer> | undefined> {
  try {
    return Uint8Array.from(await readFile(join(WEB_ROOT, name)))
  } catch {
    return undefined
  }
}

const app = new Hono()

// The API first, so a static file can never shadow a route.
app.route('/', createCourtApp(store))

app.get('/*', async (context) => {
  const path = decodeURIComponent(new URL(context.req.url).pathname)
  if (SERVER_PREFIX.some((prefix) => path.startsWith(prefix))) {
    return context.json({ error: 'not found' }, 404)
  }
  // Refuse traversal rather than sanitising it.
  if (path.includes('..')) return context.text('not found', 404)

  const name = path === '/' ? 'index.html' : path.slice(1)
  const extension = extname(name)
  const asset = await readWeb(name)
  if (asset) {
    return context.body(asset, 200, {
      'content-type': CONTENT_TYPE[extension] ?? 'application/octet-stream',
      'cache-control': name.startsWith('asset/') ? 'public, max-age=31536000, immutable' : 'no-cache',
    })
  }
  // A client-side route (no extension) gets the app shell; a missing asset does not.
  if (extension) return context.text('not found', 404)
  const shell = await readWeb('index.html')
  if (!shell) {
    return context.text('The web client is not built. Run `npm run build` first.', 503)
  }
  return context.body(shell, 200, { 'content-type': CONTENT_TYPE['.html']!, 'cache-control': 'no-cache' })
})

const port = Number(process.env['PORT'] ?? 8787)
serve({ fetch: app.fetch, port })
console.log(`roundrobin court listening on http://localhost:${port}`)

if (process.env['COURT_WORKER'] !== 'off') {
  startWorker(store)
  console.log('background worker on: webhook delivery, message outbox, hold sweep, reminders, schedule horizon')
}
