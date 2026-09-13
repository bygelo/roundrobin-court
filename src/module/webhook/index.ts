// webhook — R21 webhook egress.
//
// Operator surface under /api/v1/webhook. Producers never import this file;
// they call emitWebhook from ./contract.ts.

import {
  authorize,
  type KernelApp,
  type ModuleDeclaration,
  type RouteContributor,
  type Store,
} from '@bygelo/roundrobin-kernel'
import {
  WEBHOOK_EVENT_CODE,
  WebhookError,
  createSubscription,
  deleteSubscription,
  listDelivery,
  listSubscription,
  processWebhookDelivery,
  replayDelivery,
  rotateSubscriptionSecret,
  sendTestPing,
  updateSubscription,
} from './service.ts'

export { processWebhookDelivery, verifyWebhookSignature } from './service.ts'

export const WEBHOOK_MODULE: ModuleDeclaration = {
  module_code: 'webhook',
  package_code: 'court',
  display_name: 'Webhooks',
  schema_version: 1,
  is_removable: true,
  depend_on: ['connector'],
  capability: [
    { capability_code: 'webhook.read', description: 'See webhook subscriptions and delivery log' },
    { capability_code: 'webhook.manage', description: 'Create, rotate, replay, and delete webhooks' },
  ],
  route_prefix: ['/api/v1/webhook'],
}

async function readBody(request: { json: () => Promise<unknown> }): Promise<Record<string, unknown>> {
  const body = await request.json().catch(() => ({}))
  return body && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>) : {}
}

export function createWebhookRoute(_store: Store): RouteContributor {
  return (app: KernelApp) => {
    app.get('/api/v1/webhook/subscription', async (context) => {
      authorize(context.get('session'), 'webhook.read')
      const subscription = await listSubscription(context.get('tenant'))
      return context.json({ subscription, event_code: WEBHOOK_EVENT_CODE })
    })

    app.post('/api/v1/webhook/subscription', async (context) => {
      authorize(context.get('session'), 'webhook.manage')
      const body = await readBody(context.req)
      const created = await createSubscription(context.get('tenant'), {
        url: body['url'],
        event_code: body['event_code'],
        description: body['description'],
        is_active: body['is_active'],
      })
      return context.json(created, 201)
    })

    app.patch('/api/v1/webhook/subscription/:webhook_subscription_id', async (context) => {
      authorize(context.get('session'), 'webhook.manage')
      const body = await readBody(context.req)
      const subscription = await updateSubscription(
        context.get('tenant'),
        context.req.param('webhook_subscription_id'),
        body,
      )
      return context.json({ subscription })
    })

    app.post('/api/v1/webhook/subscription/:webhook_subscription_id/rotate-secret', async (context) => {
      authorize(context.get('session'), 'webhook.manage')
      const rotated = await rotateSubscriptionSecret(context.get('tenant'), context.req.param('webhook_subscription_id'))
      return context.json(rotated)
    })

    app.delete('/api/v1/webhook/subscription/:webhook_subscription_id', async (context) => {
      authorize(context.get('session'), 'webhook.manage')
      await deleteSubscription(context.get('tenant'), context.req.param('webhook_subscription_id'))
      return context.json({ is_deleted: true })
    })

    app.get('/api/v1/webhook/delivery', async (context) => {
      authorize(context.get('session'), 'webhook.read')
      const delivery = await listDelivery(context.get('tenant'), { status: context.req.query('status') })
      return context.json({ delivery })
    })

    app.post('/api/v1/webhook/delivery/:webhook_delivery_id/replay', async (context) => {
      authorize(context.get('session'), 'webhook.manage')
      const delivery = await replayDelivery(context.get('tenant'), context.req.param('webhook_delivery_id'))
      return context.json({ delivery })
    })

    app.post('/api/v1/webhook/process', async (context) => {
      authorize(context.get('session'), 'webhook.manage')
      const result = await processWebhookDelivery(context.get('tenant'))
      return context.json({ result })
    })

    app.post('/api/v1/webhook/test', async (context) => {
      authorize(context.get('session'), 'webhook.manage')
      const body = await readBody(context.req)
      const webhook_subscription_id = body['webhook_subscription_id']
      if (typeof webhook_subscription_id !== 'string') {
        throw new WebhookError('Choose the subscription to send a test event to.')
      }
      const delivery = await sendTestPing(context.get('tenant'), webhook_subscription_id)
      return context.json({ delivery })
    })
  }
}
