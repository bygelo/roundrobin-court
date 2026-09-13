// The portal's online payment port.
//
// Booking code calls exactly two things — charge() and readCallback() — and
// never learns which provider answered. Replacing the provider changes this
// file only; the booking tests run against the sandbox adapter and do not move.
//
// No card data ever reaches this process. The sandbox never asks for any, and
// PayMongo collects card, GCash, and Maya on its own hosted checkout page.
//
// Why this is not billing's PaymentPort binding: that port is one process-wide
// adapter bound at composition (src/app.ts, which this lane does not own), and
// its PayMongo adapter creates a Payment Intent, which needs a client-side
// attach step a booking page cannot do. A hosted Checkout Session is the
// redirect flow a guest actually completes. See FINDINGS in the lane report.

import { createHash, createHmac, timingSafeEqual } from 'node:crypto'

export type OnlineChargeInput = {
  booking_code: string
  amount: string
  currency_code: string
  idempotency_key: string
  description: string
  contact: { display_name: string; email: string; phone: string }
  /** Where the provider sends the guest back to. */
  return_url: string
}

export type OnlineCharge = {
  adapter_code: string
  provider_ref: string
  /** posted: money moved now. pending: the guest must finish on checkout_url. */
  status: 'posted' | 'pending'
  checkout_url: string | null
}

export type CallbackResult = {
  provider_ref: string
  is_paid: boolean
}

export type OnlinePaymentPort = {
  adapter_code: string
  /** Shown to the guest next to "Pay online now". */
  label: string
  charge(input: OnlineChargeInput): Promise<OnlineCharge>
  /** Verify and read a provider webhook. Throws when the signature does not verify. */
  readCallback(input: { raw_body: string; header: Record<string, string> }): Promise<CallbackResult>
}

export class PaymentCallbackRefusedError extends Error {}

/**
 * The default: deterministic, no network, no card. The same idempotency key
 * always yields the same provider_ref, so a replay is recognisable.
 */
export function createSandboxPayment(): OnlinePaymentPort {
  return {
    adapter_code: 'sandbox',
    label: 'Test checkout — no card is charged',
    async charge(input) {
      const digest = createHash('sha256').update(`${input.idempotency_key}:${input.amount}:${input.currency_code}`).digest('hex')
      return { adapter_code: 'sandbox', provider_ref: `sandbox_${digest.slice(0, 24)}`, status: 'posted', checkout_url: null }
    },
    async readCallback() {
      throw new PaymentCallbackRefusedError('the sandbox adapter settles at charge time and accepts no callback')
    },
  }
}

export type PaymongoCheckoutOption = {
  secret_key: string
  webhook_secret?: string
  base_url?: string
  fetch?: typeof fetch
}

type PaymongoResponse = {
  data?: { id?: string; attributes?: { checkout_url?: string; status?: string } }
  errors?: { detail?: string }[]
}

/** PayMongo hosted Checkout Session. Unproven against a live sandbox from this lane. */
export function createPaymongoCheckoutPayment(option: PaymongoCheckoutOption): OnlinePaymentPort {
  const base_url = (option.base_url ?? 'https://api.paymongo.com').replace(/\/$/, '')
  const doFetch = option.fetch ?? globalThis.fetch.bind(globalThis)
  const authorization = `Basic ${Buffer.from(`${option.secret_key}:`).toString('base64')}`

  return {
    adapter_code: 'paymongo',
    label: 'Card, GCash, or Maya on PayMongo',
    async charge(input) {
      const response = await doFetch(`${base_url}/v1/checkout_sessions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization, 'idempotency-key': input.idempotency_key },
        body: JSON.stringify({
          data: {
            attributes: {
              billing: { name: input.contact.display_name, email: input.contact.email, phone: input.contact.phone },
              line_items: [
                { name: input.description, quantity: 1, currency: input.currency_code.toUpperCase(), amount: Math.round(Number(input.amount) * 100) },
              ],
              payment_method_types: ['card', 'gcash', 'paymaya'],
              reference_number: input.booking_code,
              success_url: input.return_url,
              cancel_url: input.return_url,
              send_email_receipt: false,
              metadata: { booking_code: input.booking_code, idempotency_key: input.idempotency_key },
            },
          },
        }),
      })
      const body = (await response.json().catch(() => ({}))) as PaymongoResponse
      if (!response.ok || !body.data?.id) {
        throw new Error(`PayMongo could not start checkout: ${body.errors?.[0]?.detail ?? `HTTP ${response.status}`}`)
      }
      return {
        adapter_code: 'paymongo',
        provider_ref: body.data.id,
        status: 'pending',
        checkout_url: body.data.attributes?.checkout_url ?? null,
      }
    },
    async readCallback({ raw_body, header }) {
      if (!option.webhook_secret) throw new PaymentCallbackRefusedError('PAYMONGO_WEBHOOK_SECRET is not set')
      verifyPaymongoSignature(raw_body, header['paymongo-signature'] ?? '', option.webhook_secret)
      const event = JSON.parse(raw_body) as {
        data?: { attributes?: { type?: string; data?: { id?: string } } }
      }
      const type = event.data?.attributes?.type ?? ''
      const provider_ref = event.data?.attributes?.data?.id
      if (!provider_ref) throw new PaymentCallbackRefusedError('callback names no checkout session')
      return { provider_ref, is_paid: type === 'checkout_session.payment.paid' }
    },
  }
}

/** Paymongo-Signature: t=<unix>,te=<test hmac>,li=<live hmac>; hmac = sha256(`${t}.${body}`). */
export function verifyPaymongoSignature(raw_body: string, signature: string, webhook_secret: string): void {
  const part = Object.fromEntries(
    signature.split(',').map((one) => {
      const [key, ...value] = one.split('=')
      return [key?.trim() ?? '', value.join('=').trim()]
    }),
  ) as Record<string, string>
  const timestamp = part['t']
  const given = part['li'] || part['te']
  if (!timestamp || !given) throw new PaymentCallbackRefusedError('callback signature is missing')
  const expected = createHmac('sha256', webhook_secret).update(`${timestamp}.${raw_body}`).digest('hex')
  const a = Buffer.from(expected, 'utf8')
  const b = Buffer.from(given, 'utf8')
  if (a.length !== b.length || !timingSafeEqual(a, b)) throw new PaymentCallbackRefusedError('callback signature does not verify')
}

let bound: OnlinePaymentPort | undefined

/** The adapter in force: an explicit binding, else PayMongo when a secret is set, else the sandbox. */
export function getOnlinePayment(): OnlinePaymentPort {
  if (bound) return bound
  const secret_key = process.env['PAYMONGO_SECRET_KEY']?.trim()
  if (secret_key) {
    const option: PaymongoCheckoutOption = { secret_key }
    const webhook_secret = process.env['PAYMONGO_WEBHOOK_SECRET']?.trim()
    if (webhook_secret) option.webhook_secret = webhook_secret
    return createPaymongoCheckoutPayment(option)
  }
  return createSandboxPayment()
}

export function setOnlinePayment(adapter: OnlinePaymentPort): void {
  bound = adapter
}

export function resetOnlinePayment(): void {
  bound = undefined
}
