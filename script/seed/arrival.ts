// Seed step for the arrival module: waiver v1, a few signed waivers, and two
// players already checked in for today's intro lesson.
//
// Idempotent: the waiver is created only when the venue has none; acceptances
// and check-ins are unique per party/version and per subject.

import type { Uuid } from '@bygelo/roundrobin-kernel'
import type { SeedContext } from './context.ts'

const WAIVER_BODY = `By joining a session at Sideout Pickleball Club I confirm that:

1. Pickleball is a physical sport. I take part at my own risk and I am fit to play.
2. I will wear court shoes and use eye protection if the coach recommends it.
3. I will follow staff instructions and the posted court rules, including kitchen etiquette.
4. The club may take photos during open play and socials. I can ask staff to leave me out.
5. The club is not liable for lost items or injuries caused by my own actions.

I have read this waiver and accept it.`

export async function seedArrival({ tenant, organization_id }: SeedContext): Promise<void> {
  const [existing] = await tenant.query<{ arrival_waiver_version_id: Uuid }[]>`
    SELECT arrival_waiver_version_id FROM arrival_waiver_version
    WHERE organization_id = ${organization_id} AND published_at IS NOT NULL AND deleted_at IS NULL
    ORDER BY version_number DESC LIMIT 1`
  let waiver_id = existing?.arrival_waiver_version_id
  if (!waiver_id) {
    const [created] = await tenant.query<{ arrival_waiver_version_id: Uuid }[]>`
      INSERT INTO arrival_waiver_version (organization_id, version_number, title, body, published_at)
      VALUES (${organization_id},
              (SELECT coalesce(max(version_number), 0) + 1 FROM arrival_waiver_version WHERE organization_id = ${organization_id}),
              'Player waiver', ${WAIVER_BODY}, now())
      RETURNING arrival_waiver_version_id`
    waiver_id = created!.arrival_waiver_version_id
  }

  // Today's intro lesson: three named players signed at the desk; the first two have paid and arrived.
  // Chosen by name, never by created_at: the registrations share one transaction timestamp, so
  // "the first three" would pick a different set on every run and break idempotency.
  const signed_name = ['Andrea Santos', 'Paolo Reyes', 'Bea Villanueva']
  const found = await tenant.query<{ program_registration_id: Uuid; party_id: Uuid | null; display_name: string }[]>`
    SELECT r.program_registration_id, r.party_id, r.display_name
    FROM program_registration r
    JOIN program_occurrence o ON o.program_occurrence_id = r.program_occurrence_id
    JOIN program p ON p.program_id = o.program_id
    WHERE r.organization_id = ${organization_id} AND p.title = 'Intro Lesson'
      AND r.status_code IN ('registered', 'attended')
      AND r.display_name IN ${tenant.query(signed_name)}`
  const registrant = signed_name
    .map((name) => found.find((one) => one.display_name === name))
    .filter((one): one is (typeof found)[number] => one !== undefined)

  for (const one of registrant) {
    if (!one.party_id) continue
    await tenant.query`
      INSERT INTO arrival_waiver_acceptance (organization_id, party_id, arrival_waiver_version_id, user_agent, channel_code)
      VALUES (${organization_id}, ${one.party_id}, ${waiver_id}, 'Front desk tablet', 'desk')
      ON CONFLICT (party_id, arrival_waiver_version_id) DO NOTHING`
  }

  const [actor] = await tenant.query<{ actor_id: Uuid }[]>`
    SELECT actor_id FROM actor WHERE organization_id = ${organization_id} AND deleted_at IS NULL ORDER BY created_at LIMIT 1`
  if (!actor) return
  for (const one of registrant.slice(0, 2)) {
    await tenant.query`
      UPDATE program_registration SET paid_at = coalesce(paid_at, now())
      WHERE program_registration_id = ${one.program_registration_id}`
    await tenant.query`
      INSERT INTO arrival_check_in (organization_id, subject_kind, subject_id, party_id, method_code, actor_id)
      VALUES (${organization_id}, 'registration', ${one.program_registration_id}, ${one.party_id}, 'desk', ${actor.actor_id})
      ON CONFLICT (organization_id, subject_kind, subject_id) DO NOTHING`
    await tenant.query`
      UPDATE program_registration SET status_code = 'attended'
      WHERE program_registration_id = ${one.program_registration_id} AND status_code = 'registered'`
  }
}
