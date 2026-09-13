// Admin pure logic, no database: role presets, module planning, sentences,
// masking, and the public intake parser.

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { ModuleDeclaration } from '@bygelo/roundrobin-kernel'
import {
  listMissingDependency,
  listRequiredBy,
  planEnable,
  refuseDisableSentence,
  refuseEnableSentence,
} from '../src/module/admin/catalog.ts'
import { hashStatusToken, maskEmail, parseIntake, statusSentence } from '../src/module/admin/privacy.ts'
import { OWNER_ONLY_CAPABILITY, deriveRoleCapability } from '../src/module/admin/role.ts'
import { generateTemporarySecret, validateActorCode } from '../src/module/admin/staff.ts'

const CATALOG = [
  'admin.manage',
  'admin.read',
  'booking.read',
  'booking.write',
  'booking.manage',
  'kernel.api_key.manage',
  'kernel.export',
  'portal.manage',
  'portal.read',
  'score.manage',
  'score.read',
  'studio.manage',
  'studio.read',
  'court.read',
  'play.read',
]

function declare(module_code: string, depend_on: string[] = [], is_removable = true): ModuleDeclaration {
  return {
    module_code,
    package_code: 'court',
    display_name: module_code[0]!.toUpperCase() + module_code.slice(1),
    schema_version: 1,
    is_removable,
    depend_on,
    capability: [],
    route_prefix: [`/api/v1/${module_code}`],
  }
}

describe('role presets', () => {
  it('gives the owner every capability and the manager all but owner-only', () => {
    assert.deepEqual(deriveRoleCapability('owner', CATALOG), [...CATALOG].sort())
    const manager = deriveRoleCapability('manager', CATALOG)
    for (const one of OWNER_ONLY_CAPABILITY) assert.ok(!manager.includes(one), one)
    assert.ok(manager.includes('studio.manage'))
  })

  it('keeps front desk away from admin and studio manage but lets it book', () => {
    const desk = deriveRoleCapability('front_desk', CATALOG)
    assert.ok(desk.includes('booking.write'))
    assert.ok(desk.includes('portal.manage'))
    assert.ok(!desk.some((one) => one.startsWith('admin.') || one === 'studio.manage' || one.startsWith('kernel.')))
  })

  it('limits the scorer to scores, the board, and play', () => {
    assert.deepEqual(deriveRoleCapability('scorer', CATALOG), ['court.read', 'play.read', 'score.manage', 'score.read'])
  })

  it('gives the viewer only read capabilities', () => {
    assert.ok(deriveRoleCapability('viewer', CATALOG).every((one) => one.endsWith('.read')))
  })
})

describe('module planning', () => {
  const declaration = [
    declare('booking', [], false),
    declare('billing'),
    declare('portal', ['booking', 'billing']),
    declare('insight', ['portal']),
  ]

  it('plans an enable chain in dependency order, skipping modules already on', () => {
    assert.deepEqual(planEnable('insight', new Set(['booking']), declaration), ['billing', 'portal', 'insight'])
    assert.deepEqual(planEnable('portal', new Set(['booking', 'billing', 'portal']), declaration), [])
  })

  it('names the missing dependency and the enabled dependents', () => {
    const enabled = new Set(['booking', 'portal', 'insight'])
    assert.deepEqual(listMissingDependency('portal', new Set(['booking']), declaration).map((one) => one.module_code), ['billing'])
    assert.deepEqual(listRequiredBy('portal', enabled, declaration).map((one) => one.module_code), ['insight'])
    assert.match(refuseEnableSentence(declaration[2]!, [declaration[1]!]), /Portal needs Billing, which is off/)
    assert.match(
      refuseDisableSentence(declaration[0]!, [declaration[2]!, declaration[3]!]),
      /while Portal and Insight use it/,
    )
  })
})

describe('privacy intake', () => {
  it('masks an email and hashes a token', () => {
    assert.equal(maskEmail('Player@Example.com'), 'p•••@example.com')
    assert.match(hashStatusToken('abc'), /^sha256:[0-9a-f]{64}$/)
  })

  it('refuses malformed input with a sentence', () => {
    assert.throws(() => parseIntake({ request_kind: 'delete', email: 'a@b.co', booking_code: 'X' }), /copy of your data/)
    assert.throws(() => parseIntake({ request_kind: 'access', email: 'nope', booking_code: 'X' }), /email address/)
    assert.throws(() => parseIntake({ request_kind: 'access', email: 'a@b.co', booking_code: ' ' }), /booking code/)
    assert.deepEqual(parseIntake({ request_kind: 'erasure', email: ' A@B.co ', booking_code: ' BK1 ' }), {
      request_kind: 'erasure',
      email: 'a@b.co',
      booking_code: 'BK1',
    })
  })

  it('never puts personal data in a status sentence', () => {
    for (const kind of ['access', 'erasure'] as const) {
      for (const status of ['received', 'completed', 'closed'] as const) {
        assert.doesNotMatch(statusSentence(kind, status), /@/)
      }
    }
  })
})

describe('staff credential', () => {
  it('issues a readable temporary secret and validates staff codes', () => {
    const secret = generateTemporarySecret()
    assert.match(secret, /^[a-z2-9]{4}-[a-z2-9]{4}-[a-z2-9]{4}$/)
    assert.notEqual(secret, generateTemporarySecret())
    assert.equal(validateActorCode(' Desk.2 '), 'desk.2')
    assert.throws(() => validateActorCode('a'), /Staff code/)
  })
})
