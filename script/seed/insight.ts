// Seed step for the insight module.
//
// Deliberately writes nothing. Insight is a report: every figure is derived
// from the bookings, payments, orders, and deliveries the other seed steps
// create, so seeding "insight data" would mean fabricating numbers that do not
// reconcile to any record. A demo venue with no bookings shows the empty state.

import type { SeedContext } from './context.ts'

export async function seedInsight(_context: SeedContext): Promise<void> {}
