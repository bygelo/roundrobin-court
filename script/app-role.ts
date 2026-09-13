// Create (or refresh) the non-superuser role the server connects as.
//
// The kernel refuses to serve over a superuser connection, because PostgreSQL
// exempts superusers from row-level security. Migrations and the seed run as
// the owner; the server runs as this role.
//
//   DATABASE_URL=<owner url> APP_ROLE=court_app APP_ROLE_PASSWORD=... npm run db:role

import postgres from 'postgres'

const database_url = process.env['DATABASE_URL']
const role = process.env['APP_ROLE'] ?? 'court_app'
const password = process.env['APP_ROLE_PASSWORD']
if (!database_url || !password) {
  console.error('DATABASE_URL and APP_ROLE_PASSWORD are required. Refusing to guess.')
  process.exit(1)
}
if (!/^[a-z_][a-z0-9_]*$/.test(role)) {
  console.error(`APP_ROLE must be a plain lowercase identifier — got "${role}"`)
  process.exit(1)
}

const sql = postgres(database_url, { max: 1 })
try {
  const [database] = await sql<{ name: string }[]>`SELECT current_database() AS name`
  const [existing] = await sql`SELECT 1 FROM pg_roles WHERE rolname = ${role}`
  if (existing) {
    await sql.unsafe(`ALTER ROLE ${role} WITH LOGIN NOSUPERUSER PASSWORD '${password.replaceAll("'", "''")}'`)
  } else {
    await sql.unsafe(`CREATE ROLE ${role} WITH LOGIN NOSUPERUSER PASSWORD '${password.replaceAll("'", "''")}'`)
  }
  await sql.unsafe(`GRANT CONNECT ON DATABASE "${database!.name}" TO ${role}`)
  await sql.unsafe(`GRANT USAGE ON SCHEMA public TO ${role}`)
  await sql.unsafe(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${role}`)
  await sql.unsafe(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${role}`)
  // Sign-in goes through SECURITY DEFINER functions; without EXECUTE every login
  // fails with 42501 and no other symptom.
  await sql.unsafe(`GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO ${role}`)
  await sql.unsafe(`ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${role}`)
  await sql.unsafe(`ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO ${role}`)
  await sql.unsafe(`ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO ${role}`)
  console.log(`role ${role} can serve database ${database!.name}`)
} finally {
  await sql.end()
}
