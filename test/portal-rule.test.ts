// Portal pure rules and the payment adapters — no database.

import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { describe, it } from 'node:test'
import { createSandboxPayment, verifyPaymongoSignature } from '../src/module/portal/payment.ts'
import {
  bookingWindow,
  cancellationCutoffAt,
  createRecoveryToken,
  dayWindow,
  decideGuestCancel,
  findServerOwnedField,
  hashRecoveryToken,
  isDateText,
  paidAmount,
  balanceAmount,
  parseAmount,
  paymentState,
  validateContact,
} from '../src/module/portal/rule.ts'

describe('portal rules', () => {
  it('maps a venue date to its local-midnight window', () => {
    const day = dayWindow('2026-09-13', 'Asia/Manila')
    assert.equal(day.starts_at.toISOString(), '2026-09-12T16:00:00.000Z')
    assert.equal(day.ends_at.toISOString(), '2026-09-13T16:00:00.000Z')
  })

  it('computes the booking window from the venue clock', () => {
    const window = bookingWindow(new Date('2026-09-13T17:00:00Z'), 14, 'Asia/Manila')
    assert.deepEqual(window, { first_date: '2026-09-14', last_date: '2026-09-28' })
  })

  it('validates dates strictly', () => {
    assert.equal(isDateText('2026-02-29'), false)
    assert.equal(isDateText('2028-02-29'), true)
    assert.equal(isDateText('13-09-2026'), false)
  })

  it('names the state of the money on a booking', () => {
    const base = { total_amount: '500.00', posted_amount: '0', pending_amount: '0', refunded_amount: '0' }
    assert.equal(paymentState(base), 'unpaid')
    assert.equal(paymentState({ ...base, pending_amount: '500.00' }), 'pending')
    assert.equal(paymentState({ ...base, posted_amount: '200.00' }), 'partial')
    assert.equal(paymentState({ ...base, posted_amount: '500.00' }), 'paid')
    assert.equal(paymentState({ ...base, posted_amount: '500.00', refunded_amount: '250.00' }), 'partially_refunded')
    assert.equal(paymentState({ ...base, posted_amount: '500.00', refunded_amount: '500.00' }), 'refunded')
    assert.equal(paymentState({ ...base, total_amount: '0.00' }), 'not_required')
    assert.equal(paidAmount({ ...base, posted_amount: '500.00', refunded_amount: '250.00' }), '250.00')
    assert.equal(balanceAmount({ ...base, posted_amount: '0.10', total_amount: '0.30' }), '0.20')
  })

  it('checks contact details field by field', () => {
    assert.deepEqual(validateContact({ display_name: ' Maria Santos ', email: 'MARIA@Example.com', phone: '+63 917 123 4567' }).contact, {
      display_name: 'Maria Santos',
      email: 'maria@example.com',
      phone: '+63 917 123 4567',
    })
    const bad = validateContact({ display_name: '', email: 'x@', phone: 'call me' })
    assert.equal(bad.contact, undefined)
    assert.deepEqual(Object.keys(bad.problem).sort(), ['display_name', 'email', 'phone'])
  })

  it('refuses server-owned fields', () => {
    assert.equal(findServerOwnedField({ session_id: 'x', total_amount: '1' }), 'total_amount')
    assert.equal(findServerOwnedField({ session_id: 'x' }), undefined)
  })

  it('allows releasing a hold anytime and cancelling a confirmed booking only before the cutoff', () => {
    const cutoff = cancellationCutoffAt(new Date('2026-09-20T10:00:00Z'), 24)
    assert.equal(cutoff.toISOString(), '2026-09-19T10:00:00.000Z')
    const time_zone = 'Asia/Manila'
    assert.equal(decideGuestCancel({ status: 'hold', cancellation_cutoff_at: cutoff, now: new Date('2026-09-20T09:00:00Z'), time_zone }).is_cancellable, true)
    assert.equal(decideGuestCancel({ status: 'confirmed', cancellation_cutoff_at: cutoff, now: new Date('2026-09-19T09:00:00Z'), time_zone }).is_cancellable, true)
    const late = decideGuestCancel({ status: 'confirmed', cancellation_cutoff_at: cutoff, now: new Date('2026-09-19T11:00:00Z'), time_zone })
    assert.equal(late.is_cancellable, false)
    if (!late.is_cancellable) assert.match(late.reason, /closed at Sat, Sep 19/)
  })

  it('makes 128-bit recovery tokens and stores only their hash', () => {
    const token = createRecoveryToken()
    assert.equal(Buffer.from(token, 'base64url').length, 16)
    assert.match(hashRecoveryToken(token), /^[0-9a-f]{64}$/)
    assert.notEqual(createRecoveryToken(), token)
  })

  it('parses staff-typed amounts', () => {
    assert.equal(parseAmount('500'), 500)
    assert.equal(parseAmount('500.5'), 500.5)
    assert.equal(parseAmount('0'), undefined)
    assert.equal(parseAmount('-5'), undefined)
    assert.equal(parseAmount('1.234'), undefined)
  })
})

describe('portal payment adapters', () => {
  it('sandbox is deterministic per idempotency key and posts immediately', async () => {
    const sandbox = createSandboxPayment()
    const input = {
      booking_code: 'abc',
      amount: '500.00',
      currency_code: 'PHP',
      idempotency_key: 'portal:abc:online',
      description: 'Court 1',
      contact: { display_name: 'A B', email: 'a@b.co', phone: '0917' },
      return_url: 'http://x',
    }
    const first = await sandbox.charge(input)
    const second = await sandbox.charge(input)
    assert.equal(first.status, 'posted')
    assert.equal(first.provider_ref, second.provider_ref)
    assert.notEqual((await sandbox.charge({ ...input, idempotency_key: 'other' })).provider_ref, first.provider_ref)
  })

  it('verifies a PayMongo webhook signature and refuses a forged one', () => {
    const body = '{"data":{"attributes":{"type":"checkout_session.payment.paid"}}}'
    const secret = 'whsk_test'
    const t = '1700000000'
    const good = createHmac('sha256', secret).update(`${t}.${body}`).digest('hex')
    assert.doesNotThrow(() => verifyPaymongoSignature(body, `t=${t},te=${good},li=`, secret))
    assert.throws(() => verifyPaymongoSignature(body, `t=${t},te=${'0'.repeat(64)},li=`, secret))
    assert.throws(() => verifyPaymongoSignature(body, '', secret))
  })
})
