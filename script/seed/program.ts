// Seed step for the program module: a weekly beginner clinic, a Saturday social,
// a private event next Friday, today's intro lesson, and a handful of
// registrations including one waitlisted player.
//
// Idempotent: programs are found by title, registrations are only added to an
// occurrence that has none.

import type { Uuid } from '@bygelo/roundrobin-kernel'
import type { SeedContext } from './context.ts'
import { createProgram, materializeProgram, parseProgram, register } from '../../src/module/program/service.ts'
import { addDay, isoWeekday, localDate } from '../../src/module/program/schedule.ts'

const TIME_ZONE = 'Asia/Manila'

function nextWeekday(from: string, weekday: number): string {
  let date = from
  while (isoWeekday(date) !== weekday) date = addDay(date, 1)
  return date
}

export async function seedProgram({ tenant, organization_id }: SeedContext): Promise<void> {
  const today = localDate(new Date(), TIME_ZONE)
  const [court] = await tenant.query<{ resource_id: Uuid }[]>`
    SELECT resource_id FROM resource WHERE organization_id = ${organization_id} AND deleted_at IS NULL
    ORDER BY sort_order, display_name LIMIT 1`

  const definition = [
    {
      kind_code: 'clinic',
      title: 'Beginner Clinic',
      description: 'Grips, the dink, third-shot drop, and kitchen rules. Paddles available to borrow.',
      host_name: 'Coach Mia',
      price_amount: '350',
      capacity_count: 12,
      is_published: true,
      resource_id: court?.resource_id ?? null,
      schedule: {
        schedule_code: 'weekly',
        weekday_number: [2, 4],
        first_date: today,
        until_date: addDay(today, 56),
        starts_local: '18:00',
        ends_local: '19:30',
      },
    },
    {
      kind_code: 'social',
      title: 'Saturday Social',
      description: 'Rotating doubles for every level. Meet players, stay for coffee.',
      host_name: 'Sideout Crew',
      price_amount: '200',
      capacity_count: 24,
      is_published: true,
      schedule: {
        schedule_code: 'weekly',
        weekday_number: [6],
        first_date: today,
        until_date: addDay(today, 56),
        starts_local: '09:00',
        ends_local: '11:00',
      },
    },
    {
      kind_code: 'private_event',
      title: 'Company Night — Makati Tech Team',
      description: 'Private booking: round robin and dinner for 16.',
      host_name: 'Coach Mia',
      price_amount: '0',
      capacity_count: 16,
      is_published: false,
      schedule: {
        schedule_code: 'once',
        first_date: nextWeekday(addDay(today, 1), 5),
        starts_local: '18:00',
        ends_local: '21:00',
      },
    },
    {
      kind_code: 'lesson',
      title: 'Intro Lesson',
      description: 'A small-group first lesson. Four players, one coach.',
      host_name: 'Coach Mia',
      price_amount: '600',
      capacity_count: 4,
      is_published: true,
      schedule: { schedule_code: 'once', first_date: today, starts_local: '19:00', ends_local: '20:00' },
    },
  ]

  const program_id = new Map<string, Uuid>()
  for (const one of definition) {
    const [existing] = await tenant.query<{ program_id: Uuid }[]>`
      SELECT program_id FROM program WHERE organization_id = ${organization_id} AND title = ${one.title} AND deleted_at IS NULL`
    if (existing) {
      await materializeProgram(tenant, existing.program_id)
      program_id.set(one.title, existing.program_id)
      continue
    }
    const created = await createProgram(tenant, parseProgram(one as Record<string, unknown>))
    program_id.set(one.title, created.program.program_id)
  }

  const player = [
    ['Andrea Santos', 'andrea.santos@example.com', '+63 917 555 0101'],
    ['Paolo Reyes', 'paolo.reyes@example.com', '+63 917 555 0102'],
    ['Bea Villanueva', 'bea.villanueva@example.com', '+63 917 555 0103'],
    ['Carlo Mendoza', 'carlo.mendoza@example.com', '+63 917 555 0104'],
    ['Nicole Ramos', 'nicole.ramos@example.com', '+63 917 555 0105'],
    ['Miguel Tan', 'miguel.tan@example.com', '+63 917 555 0106'],
    ['Isabel Garcia', 'isabel.garcia@example.com', '+63 917 555 0107'],
    ['Rafael Lim', 'rafael.lim@example.com', '+63 917 555 0108'],
    ['Jasmine Cruz', 'jasmine.cruz@example.com', '+63 917 555 0109'],
  ] as const

  // Intro lesson today: four seats taken and one on the waitlist.
  // Next clinic: three players. Next social: two players.
  const plan: { title: string; player_index: number[] }[] = [
    { title: 'Intro Lesson', player_index: [0, 1, 2, 3, 4] },
    { title: 'Beginner Clinic', player_index: [5, 6, 7] },
    { title: 'Saturday Social', player_index: [8, 0] },
  ]
  for (const one of plan) {
    const id = program_id.get(one.title)
    if (!id) continue
    const [occurrence] = await tenant.query<{ program_occurrence_id: Uuid; registration_count: number }[]>`
      SELECT o.program_occurrence_id,
             (SELECT count(*)::int FROM program_registration r WHERE r.program_occurrence_id = o.program_occurrence_id) AS registration_count
      FROM program_occurrence o
      WHERE o.organization_id = ${organization_id} AND o.program_id = ${id} AND o.status_code = 'scheduled' AND o.ends_at > now()
      ORDER BY o.starts_at LIMIT 1`
    if (!occurrence || occurrence.registration_count > 0) continue
    for (const index of one.player_index) {
      const [display_name, email_address, phone_number] = player[index]!
      await register(
        tenant,
        occurrence.program_occurrence_id,
        { display_name, email_address, phone_number, arrival_waiver_version_id: null },
        { is_public: false },
      )
    }
  }
}
