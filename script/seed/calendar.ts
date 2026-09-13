// Seed step for the calendar module: one whole-venue feed.
//
// Only the token hash is stored, so the URL can be printed only on the run that
// creates it. Later runs say so; rotate the feed in Connections → Calendar to
// get a fresh link.

import { createFeed } from '../../src/module/calendar/service.ts'
import type { SeedContext } from './context.ts'

export async function seedCalendar({ tenant, organization_id }: SeedContext): Promise<void> {
  const [existing] = await tenant.query<{ token_prefix: string }[]>`
    SELECT token_prefix FROM calendar_feed
    WHERE organization_id = ${organization_id} AND scope_code = 'venue' AND is_active AND deleted_at IS NULL
    LIMIT 1`
  if (existing) {
    console.log(`  calendar feed already exists (link starts ${existing.token_prefix}…); rotate it under Connections → Calendar for a new URL`)
    return
  }
  const created = await createFeed(tenant, { scope_code: 'venue', display_name: 'All courts' })
  const origin = process.env['COURT_PUBLIC_ORIGIN'] ?? 'http://localhost:8787'
  console.log(`  calendar feed: ${origin}${created.feed_path}`)
}
