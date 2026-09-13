// Staff role presets (R04).
//
// A preset is a rule over the capability catalog, not a frozen list: a module
// added next month lands in owner and manager automatically, and a new *.read
// capability lands in viewer. Upserting is idempotent and runs on the first
// admin read, so a venue never needs a separate "install roles" step.

import type { TenantContext, Uuid } from '@bygelo/roundrobin-kernel'

export type RoleCode = 'owner' | 'manager' | 'front_desk' | 'scorer' | 'viewer'

export type RolePreset = {
  role_code: RoleCode
  display_name: string
  /** One line a venue owner reads when choosing a role. */
  description: string
  select: (capability_code: string) => boolean
}

/** Capability that only an owner holds: changing staff and modules, keys, and exports. */
export const OWNER_ONLY_CAPABILITY = ['admin.manage', 'kernel.api_key.manage', 'kernel.export'] as const

const FRONT_DESK_CAPABILITY = new Set([
  'court.read',
  'portal.read',
  'portal.manage',
  'booking.read',
  'booking.write',
  'arrival.read',
  'arrival.manage',
  'billing.read',
  'billing.write',
  'shop.read',
  'shop.manage',
  'commerce.read',
  'commerce.write',
  'program.read',
  'play.read',
  'play.manage',
  'message.read',
])

const SCORER_CAPABILITY = new Set(['score.read', 'score.manage', 'court.read', 'play.read'])

export const ROLE_PRESET: RolePreset[] = [
  {
    role_code: 'owner',
    display_name: 'Owner',
    description: 'Everything, including staff, modules, API keys, and venue data.',
    select: () => true,
  },
  {
    role_code: 'manager',
    display_name: 'Manager',
    description: 'Runs the whole venue day to day, but cannot change staff, modules, API keys, or exports.',
    select: (code) => !(OWNER_ONLY_CAPABILITY as readonly string[]).includes(code),
  },
  {
    role_code: 'front_desk',
    display_name: 'Front desk',
    description: 'Books courts, checks players in, takes payments, sells at the counter, and runs open play.',
    select: (code) => FRONT_DESK_CAPABILITY.has(code),
  },
  {
    role_code: 'scorer',
    display_name: 'Scorer',
    description: 'Enters and corrects match scores; can see the court board and open play.',
    select: (code) => SCORER_CAPABILITY.has(code),
  },
  {
    role_code: 'viewer',
    display_name: 'Viewer',
    description: 'Can look at every screen but cannot change anything.',
    select: (code) => code.endsWith('.read'),
  },
]

export function findRolePreset(role_code: string): RolePreset | undefined {
  return ROLE_PRESET.find((one) => one.role_code === role_code)
}

/** The capability set a preset grants from a given catalog. Pure. */
export function deriveRoleCapability(role_code: RoleCode, catalog: string[]): string[] {
  const preset = findRolePreset(role_code)
  if (!preset) return []
  return catalog.filter((one) => preset.select(one)).sort()
}

/**
 * Upsert every preset role and sync its capability rows to the catalog.
 * Idempotent; returns role_id by role_code.
 */
export async function ensureRolePreset(tenant: TenantContext): Promise<Map<string, Uuid>> {
  const catalog = (
    await tenant.query<{ capability_code: string }[]>`SELECT capability_code FROM capability ORDER BY capability_code`
  ).map((one) => one.capability_code)

  const role_id = new Map<string, Uuid>()
  for (const preset of ROLE_PRESET) {
    const [role] = await tenant.query<{ role_id: Uuid }[]>`
      INSERT INTO role (organization_id, role_code, display_name, is_system)
      VALUES (${tenant.organization_id}, ${preset.role_code}, ${preset.display_name}, true)
      ON CONFLICT (organization_id, role_code) DO UPDATE SET is_system = true
      RETURNING role_id`
    const granted = deriveRoleCapability(preset.role_code, catalog)
    await tenant.query`
      INSERT INTO role_capability (organization_id, role_id, capability_code)
      SELECT ${tenant.organization_id}, ${role!.role_id}, capability_code
      FROM capability WHERE capability_code = ANY(${granted}::text[])
      ON CONFLICT DO NOTHING`
    await tenant.query`
      DELETE FROM role_capability
      WHERE organization_id = ${tenant.organization_id} AND role_id = ${role!.role_id}
        AND NOT (capability_code = ANY(${granted}::text[]))`
    role_id.set(preset.role_code, role!.role_id)
  }
  return role_id
}
