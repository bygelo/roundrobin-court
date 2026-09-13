// message — R22 transactional notification.
//
// The venue's player messages: confirmation, receipt, reminder, waiver prompt,
// waitlist opening, program registration, court change, closure, pickup, and
// cancellation. One player, one business record, one message. Campaigns and
// broadcasts are intentionally not supported.
//
// Producers call notifyPlayer (contract.ts). This file is the operator surface:
// templates, the outbox, provider status, player preferences, and the reminder
// sweep.

import { authorize, type KernelApp, type ModuleDeclaration, type RouteContributor, type Store } from '@bygelo/roundrobin-kernel'
import { MessageInputError, requireChannel, requireKind } from './kind.ts'
import {
  listOutbox,
  listTemplate,
  previewTemplate,
  processOutbox,
  readPreference,
  readProviderStatus,
  retryDelivery,
  runReminder,
  savePreference,
  saveTemplate,
  sendTestEmail,
} from './service.ts'

export const MESSAGE_MODULE: ModuleDeclaration = {
  module_code: 'message',
  package_code: 'court',
  display_name: 'Player messages',
  schema_version: 1,
  is_removable: true,
  depend_on: ['notification'],
  capability: [
    { capability_code: 'message.read', description: 'See player messages' },
    { capability_code: 'message.manage', description: 'Change player messages' },
  ],
  route_prefix: ['/api/v1/message'],
}

async function readBody(request: { json: () => Promise<unknown> }): Promise<Record<string, unknown>> {
  let value: unknown
  try {
    value = await request.json()
  } catch {
    throw new MessageInputError('The request body must be JSON.')
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new MessageInputError('The request body must be a JSON object.')
  }
  return value as Record<string, unknown>
}

async function readOptionalBody(request: { text: () => Promise<string> }): Promise<Record<string, unknown>> {
  const text = await request.text()
  if (text.trim() === '') return {}
  return readBody({ json: async () => JSON.parse(text) as unknown })
}

export function createMessageRoute(_store: Store): RouteContributor {
  return (app: KernelApp) => {
    app.get('/api/v1/message/template', async (context) => {
      authorize(context.get('session'), 'message.read')
      return context.json(await listTemplate(context.get('tenant')))
    })

    app.put('/api/v1/message/template/:message_kind/:channel', async (context) => {
      authorize(context.get('session'), 'message.manage')
      const meta = requireKind(context.req.param('message_kind'))
      const channel = requireChannel(context.req.param('channel'))
      const body = await readBody(context.req)
      const template = await saveTemplate(context.get('tenant'), meta, channel, body)
      return context.json({ template })
    })

    app.post('/api/v1/message/template/:message_kind/:channel/preview', async (context) => {
      authorize(context.get('session'), 'message.read')
      const meta = requireKind(context.req.param('message_kind'))
      const channel = requireChannel(context.req.param('channel'))
      const body = await readOptionalBody(context.req)
      return context.json({ preview: await previewTemplate(context.get('tenant'), meta, channel, body) })
    })

    app.get('/api/v1/message/outbox', async (context) => {
      authorize(context.get('session'), 'message.read')
      const status = context.req.query('status')
      return context.json(await listOutbox(context.get('tenant'), status ? { status } : {}))
    })

    app.post('/api/v1/message/outbox/process', async (context) => {
      authorize(context.get('session'), 'message.manage')
      return context.json({ result: await processOutbox(context.get('tenant')) })
    })

    app.post('/api/v1/message/outbox/:notification_delivery_id/retry', async (context) => {
      authorize(context.get('session'), 'message.manage')
      return context.json(await retryDelivery(context.get('tenant'), context.req.param('notification_delivery_id')))
    })

    app.get('/api/v1/message/provider', async (context) => {
      authorize(context.get('session'), 'message.read')
      return context.json({ provider: await readProviderStatus(context.get('tenant')) })
    })

    // One test email to an address the owner types. Not a player message, so
    // it bypasses the outbox; the result says honestly whether it went out.
    app.post('/api/v1/message/test-email', async (context) => {
      authorize(context.get('session'), 'message.manage')
      const body = await readBody(context.req)
      return context.json({ result: await sendTestEmail(context.get('tenant'), body) })
    })

    app.get('/api/v1/message/preference', async (context) => {
      authorize(context.get('session'), 'message.read')
      return context.json(await readPreference(context.get('tenant'), context.req.query('contact') ?? ''))
    })

    app.put('/api/v1/message/preference', async (context) => {
      authorize(context.get('session'), 'message.manage')
      const body = await readBody(context.req)
      return context.json(await savePreference(context.get('tenant'), body))
    })

    app.post('/api/v1/message/reminder/run', async (context) => {
      authorize(context.get('session'), 'message.manage')
      return context.json({ result: await runReminder(context.get('tenant')) })
    })
  }
}
