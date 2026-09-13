// message — pure template rules. No database.

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  BODY_LIMIT,
  MESSAGE_CHANNEL,
  MESSAGE_KIND,
  defaultTemplate,
  errorSentence,
  findKind,
  listPlaceholder,
  normalizeDetail,
  outboxStatus,
  phoneKey,
  renderText,
  validateTemplate,
} from '../src/module/message/kind.ts'

const confirmed = findKind('booking_confirmed')!

describe('message template rules', () => {
  it('covers the ten contract kinds, five essential and five optional', () => {
    assert.equal(MESSAGE_KIND.length, 10)
    assert.deepEqual(
      MESSAGE_KIND.filter((one) => one.is_essential).map((one) => one.message_kind).sort(),
      ['booking_cancelled', 'booking_confirmed', 'booking_receipt', 'closure', 'court_changed'],
    )
  })

  it('ships default copy that passes its own rules on both channels', () => {
    for (const meta of MESSAGE_KIND) {
      for (const channel of MESSAGE_CHANNEL) {
        const copy = defaultTemplate(meta, channel)
        assert.doesNotThrow(() => validateTemplate(meta, channel, copy), `${meta.message_kind}/${channel}`)
        const rendered = renderText(copy.body, meta.sample)
        assert.ok(!rendered.includes('{{'), `${meta.message_kind}/${channel} renders every placeholder from its sample`)
      }
    }
  })

  it('refuses an unknown placeholder with a sentence naming the allowed ones', () => {
    assert.throws(
      () => validateTemplate(confirmed, 'sms', { body: 'Hi {{player_name}}, bring {{shoe_size}}' }),
      (error: Error) => error.message.includes('{{shoe_size}}') && error.message.includes('{{booking_code}}'),
    )
    assert.throws(() => validateTemplate(confirmed, 'email', { subject: '{{nope}}', body: 'ok' }), /not available/)
  })

  it('refuses an unclosed placeholder', () => {
    assert.throws(() => validateTemplate(confirmed, 'sms', { body: 'Hi {{player_name' }), /not closed/)
  })

  it('enforces channel limits and subject rules', () => {
    assert.throws(() => validateTemplate(confirmed, 'sms', { body: 'x'.repeat(BODY_LIMIT.sms + 1) }), /at most 320/)
    assert.doesNotThrow(() => validateTemplate(confirmed, 'sms', { body: 'x'.repeat(320) }))
    assert.throws(() => validateTemplate(confirmed, 'email', { subject: 's', body: 'x'.repeat(1001) }), /at most 1000/)
    assert.throws(() => validateTemplate(confirmed, 'email', { body: 'hello' }), /subject/)
    assert.throws(() => validateTemplate(confirmed, 'email', { subject: 's'.repeat(121), body: 'hello' }), /120/)
    assert.throws(() => validateTemplate(confirmed, 'sms', { subject: 'Hi', body: 'hello' }), /no subject/)
    assert.throws(() => validateTemplate(confirmed, 'sms', { body: '   ' }), /empty/)
  })

  it('renders placeholders and blanks the missing ones', () => {
    assert.equal(renderText('Hi {{ player_name }}, {{court_name}} {{time}}', { player_name: 'Ana', court_name: 'Court 2' }), 'Hi Ana, Court 2')
    assert.deepEqual(listPlaceholder('{{a}} and {{ b }}'), ['a', 'b'])
  })

  it('folds producer aliases into documented placeholders without overriding explicit values', () => {
    const detail = normalizeDetail({ player: 'Ana', court: 'Court 4', starts_at: 'Sat 6 PM', total_amount: '800.00' })
    assert.equal(detail['player_name'], 'Ana')
    assert.equal(detail['court_name'], 'Court 4')
    assert.equal(detail['date'], 'Sat 6 PM')
    assert.equal(detail['amount'], '800.00')
    assert.equal(normalizeDetail({ player: 'Alias', player_name: 'Explicit' })['player_name'], 'Explicit')
  })

  it('never lets a contact detail into an error sentence', () => {
    const sentence = errorSentence('provider refused: bad number +63 917 555 1234 for andrea@example.com')!
    assert.ok(!sentence.includes('917 555'))
    assert.ok(!sentence.includes('andrea@'))
    assert.ok(sentence.includes('••••1234'))
    assert.ok(sentence.endsWith('.'))
    assert.equal(errorSentence(null), null)
  })

  it('reads a queued row as held when no provider is configured', () => {
    assert.equal(outboxStatus('queued', false), 'held')
    assert.equal(outboxStatus('queued', true), 'queued')
    assert.equal(outboxStatus('delivered', false), 'sent')
    assert.equal(outboxStatus('suppressed', true), 'suppressed')
  })

  it('matches phone numbers across local and international prefixes', () => {
    assert.equal(phoneKey('+63 917 555 1234'), phoneKey('0917-555-1234'))
  })
})
