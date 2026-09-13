// member — R15 membership and entitlement.
//
// Operator routes under /api/v1/member over the membership pack, plus the
// pricing/entitlement port in contract.ts that the portal consults at booking.

import { authorize, type KernelApp, type ModuleDeclaration, type RouteContributor, type Store } from '@bygelo/roundrobin-kernel'
import {
  changeMembership,
  createMemberPlan,
  enrolMember,
  issueMemberPass,
  listMember,
  listMemberPlan,
  quote,
  readEntitlement,
  setSessionRule,
  updateMemberPlan,
} from './service.ts'
import { readMemberBilling, setAutoRenew, settleMembershipBilling } from './billing.ts'
import { runMembershipRenewal } from './renewal.ts'
import { atomic } from '../shop/atomic.ts'

export const MEMBER_MODULE: ModuleDeclaration = {
  module_code: 'member',
  package_code: 'court',
  display_name: 'Membership',
  schema_version: 1,
  is_removable: true,
  depend_on: ['membership', 'booking'],
  capability: [
    { capability_code: 'member.read', description: 'See membership' },
    { capability_code: 'member.manage', description: 'Change membership' },
  ],
  route_prefix: ['/api/v1/member'],
}

async function readBody(request: { json: () => Promise<unknown> }): Promise<Record<string, unknown>> {
  try {
    const body = await request.json()
    return body && typeof body === 'object' ? (body as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

export function createMemberRoute(_store: Store): RouteContributor {
  return (app: KernelApp) => {
    app.get('/api/v1/member/plan', async (context) => {
      authorize(context.get('session'), 'member.read')
      return context.json({ plan: await listMemberPlan(context.get('tenant')) })
    })

    app.post('/api/v1/member/plan', async (context) => {
      authorize(context.get('session'), 'member.manage')
      const body = await readBody(context.req)
      const plan = await atomic(context.get('tenant'), (tenant) => createMemberPlan(tenant, body))
      return context.json({ plan }, 201)
    })

    app.patch('/api/v1/member/plan/:member_plan_id', async (context) => {
      authorize(context.get('session'), 'member.manage')
      const body = await readBody(context.req)
      const plan = await atomic(context.get('tenant'), (tenant) => updateMemberPlan(tenant, context.req.param('member_plan_id'), body))
      return context.json({ plan })
    })

    app.get('/api/v1/member/member', async (context) => {
      authorize(context.get('session'), 'member.read')
      const member = await atomic(context.get('tenant'), async (tenant) => {
        // Payments arrive through billing with no event to hook; apply any paid
        // membership invoice before showing statuses.
        await settleMembershipBilling(tenant)
        return listMember(tenant, {
          status: context.req.query('status') || undefined,
          search: context.req.query('search') || undefined,
        })
      })
      return context.json({ member })
    })

    app.get('/api/v1/member/member/:membership_id/billing', async (context) => {
      authorize(context.get('session'), 'member.read')
      const billing = await atomic(context.get('tenant'), async (tenant) => {
        await settleMembershipBilling(tenant)
        return readMemberBilling(tenant, context.req.param('membership_id'))
      })
      return context.json({ billing })
    })

    app.post('/api/v1/member/member/:membership_id/auto-renew', async (context) => {
      const session = context.get('session')
      authorize(session, 'member.manage')
      const body = await readBody(context.req)
      const billing = await atomic(context.get('tenant'), (tenant) =>
        setAutoRenew(tenant, context.req.param('membership_id'), body['is_auto_renew'], session.actor_id),
      )
      return context.json({ billing })
    })

    /** Run the renewal job for this venue now — the worker runs the same function on a timer. */
    app.post('/api/v1/member/renewal/run', async (context) => {
      authorize(context.get('session'), 'member.manage')
      const result = await atomic(context.get('tenant'), (tenant) => runMembershipRenewal(tenant))
      return context.json({ result })
    })

    app.post('/api/v1/member/member', async (context) => {
      authorize(context.get('session'), 'member.manage')
      const body = await readBody(context.req)
      const member = await atomic(context.get('tenant'), (tenant) => enrolMember(tenant, body))
      return context.json({ member }, 201)
    })

    for (const action of ['freeze', 'unfreeze', 'cancel'] as const) {
      app.post(`/api/v1/member/member/:membership_id/${action}`, async (context) => {
        const session = context.get('session')
        authorize(session, 'member.manage')
        const body = await readBody(context.req)
        const member = await atomic(context.get('tenant'), (tenant) =>
          changeMembership(tenant, context.req.param('membership_id'), action, body, session.actor_id),
        )
        return context.json({ member })
      })
    }

    app.post('/api/v1/member/pass', async (context) => {
      authorize(context.get('session'), 'member.manage')
      const body = await readBody(context.req)
      const member = await atomic(context.get('tenant'), (tenant) => issueMemberPass(tenant, body))
      return context.json({ member }, 201)
    })

    app.get('/api/v1/member/party/:party_id/entitlement', async (context) => {
      authorize(context.get('session'), 'member.read')
      return context.json({ entitlement: await readEntitlement(context.get('tenant'), context.req.param('party_id')) })
    })

    app.post('/api/v1/member/session/:session_id/rule', async (context) => {
      authorize(context.get('session'), 'member.manage')
      const body = await readBody(context.req)
      const rule = await setSessionRule(context.get('tenant'), context.req.param('session_id'), body['is_member_only'])
      return context.json({ rule })
    })

    /** Preview what a player would pay — the same port the portal calls at booking. */
    app.get('/api/v1/member/quote', async (context) => {
      authorize(context.get('session'), 'member.read')
      const result = await quote(context.get('tenant'), {
        party_id: context.req.query('party_id') || null,
        session_id: context.req.query('session_id') ?? '',
        base_amount: context.req.query('base_amount') ?? '0',
      })
      return context.json({ quote: result })
    })
  }
}
