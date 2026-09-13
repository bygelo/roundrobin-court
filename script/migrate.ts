// Apply the OS's migrations, then this app's own.
//
// The runner comes from the kernel — an app should not reimplement the gapless
// check, the checksum check, or the transaction handling. What the app supplies
// is the ORDER: kernel, then the packs it installs, then itself.

import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { applyMigration, createStore, readPackageMigration } from '@bygelo/roundrobin-kernel'

const require = createRequire(import.meta.url)
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

/** Where an installed package physically lives, so its migration/ can be read. */
function packageRoot(specifier: string): string {
  return dirname(require.resolve(`${specifier}/package.json`))
}

// Dependency order, stated once. Every pack's tables reference organization, so
// kernel is always first, and this app is always last.
const PACK_CODE = [
  'kernel',
  'booking',
  'billing',
  'membership',
  'commerce',
  'notification',
  'connector',
  'consent',
  'output',
  'scan',
] as const

const SOURCE: { package_code: string; root: string }[] = [
  ...PACK_CODE.map((package_code) => ({
    package_code,
    root: packageRoot(`@bygelo/roundrobin-${package_code}`),
  })),
  { package_code: 'court', root: ROOT },
]

const database_url = process.env['DATABASE_URL']
if (!database_url) {
  console.error('DATABASE_URL is not set. Refusing to guess a database.')
  process.exit(1)
}

const store = createStore(database_url)
try {
  const migration = []
  for (const one of SOURCE) {
    migration.push(...(await readPackageMigration(one.root, one.package_code)))
  }
  const count = await applyMigration(store, migration, (label) => console.log(`applied ${label}`))
  if (count === 0) console.log('up to date — nothing to apply')
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
} finally {
  await store.close()
}
