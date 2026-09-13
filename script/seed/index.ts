// Seed steps, in the order they run. Pre-registered by the foundation
// checkpoint so lanes never edit this file: court first (it creates the site and
// courts everything else hangs off), then each module.
//
// Every step must be idempotent — running the seed twice is not an error and
// creates no duplicate.

import type { SeedContext } from './context.ts'
import { seedAdmin } from './admin.ts'
import { seedArrival } from './arrival.ts'
import { seedCalendar } from './calendar.ts'
import { seedCourt } from './court.ts'
import { seedDisplay } from './display.ts'
import { seedDupr } from './dupr.ts'
import { seedInsight } from './insight.ts'
import { seedMember } from './member.ts'
import { seedMessage } from './message.ts'
import { seedPlay } from './play.ts'
import { seedPortal } from './portal.ts'
import { seedProgram } from './program.ts'
import { seedScore } from './score.ts'
import { seedShop } from './shop.ts'
import { seedStudio } from './studio.ts'
import { seedWebhook } from './webhook.ts'

export const SEED_STEP: { step_code: string; run: (context: SeedContext) => Promise<void> }[] = [
  { step_code: 'court', run: seedCourt },
  { step_code: 'portal', run: seedPortal },
  { step_code: 'studio', run: seedStudio },
  { step_code: 'program', run: seedProgram },
  { step_code: 'play', run: seedPlay },
  { step_code: 'arrival', run: seedArrival },
  { step_code: 'score', run: seedScore },
  { step_code: 'display', run: seedDisplay },
  { step_code: 'shop', run: seedShop },
  { step_code: 'member', run: seedMember },
  { step_code: 'insight', run: seedInsight },
  { step_code: 'message', run: seedMessage },
  { step_code: 'calendar', run: seedCalendar },
  { step_code: 'webhook', run: seedWebhook },
  { step_code: 'dupr', run: seedDupr },
  { step_code: 'admin', run: seedAdmin },
]
