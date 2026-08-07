// Development entry point.
//
// Everything interesting happens in app.ts and in the OS. This file only binds
// a port.

import { serve } from '@hono/node-server'
import { createStore, registerModule, withOwner } from '@bygelo/roundrobbin-kernel'
import { COURT_DECLARATION, createCourtApp } from './app.ts'

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

const port = Number(process.env['PORT'] ?? 8787)
serve({ fetch: createCourtApp(store).fetch, port })
console.log(`roundrobbin court listening on http://localhost:${port}`)
