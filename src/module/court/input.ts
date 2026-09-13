// Request-body reading and the court module's refusals.
//
// Every refusal is a DomainError with a sentence an operator can act on; the
// kernel maps the declared status. No handler hand-rolls a 4xx/5xx body.

import { DomainError } from '@bygelo/roundrobin-kernel'

export class CourtInputError extends DomainError {
  constructor(message: string) {
    super(message, 400)
  }
}

export class CourtConflictError extends DomainError {
  constructor(message: string) {
    super(message, 409)
  }
}

export class CourtNotFoundError extends DomainError {
  constructor(message: string) {
    super(message, 404)
  }
}

export type Body = Record<string, unknown>

export async function readBody(request: { json: () => Promise<unknown> }): Promise<Body> {
  let value: unknown
  try {
    value = await request.json()
  } catch {
    throw new CourtInputError('The request body must be JSON.')
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new CourtInputError('The request body must be a JSON object.')
  }
  return value as Body
}

export function has(body: Body, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(body, key) && body[key] !== undefined
}

export function readText(body: Body, key: string, label: string, option: { max?: number } = {}): string {
  const value = body[key]
  if (typeof value !== 'string' || value.trim() === '') throw new CourtInputError(`${label} is required.`)
  const text = value.trim()
  if (text.length > (option.max ?? 200)) throw new CourtInputError(`${label} must be at most ${option.max ?? 200} characters.`)
  return text
}

export function readOptionalText(body: Body, key: string, label: string, option: { max?: number } = {}): string | null {
  const value = body[key]
  if (value === undefined || value === null) return null
  if (typeof value !== 'string') throw new CourtInputError(`${label} must be text.`)
  const text = value.trim()
  if (text === '') return null
  if (text.length > (option.max ?? 200)) throw new CourtInputError(`${label} must be at most ${option.max ?? 200} characters.`)
  return text
}

export function readInteger(body: Body, key: string, label: string, min: number, max: number): number {
  const value = body[key]
  const number = typeof value === 'string' && value.trim() !== '' ? Number(value) : value
  if (typeof number !== 'number' || !Number.isInteger(number) || number < min || number > max) {
    throw new CourtInputError(`${label} must be a whole number from ${min} to ${max}.`)
  }
  return number
}

export function readBoolean(body: Body, key: string, label: string): boolean {
  const value = body[key]
  if (typeof value !== 'boolean') throw new CourtInputError(`${label} must be true or false.`)
  return value
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID.test(value)
}

export function readUuid(body: Body, key: string, label: string): string {
  const value = body[key]
  if (!isUuid(value)) throw new CourtInputError(`${label} is required.`)
  return value
}

/** A path parameter that must be a uuid; anything else is simply not found. */
export function requireUuidParam(value: string | undefined, what: string): string {
  if (!isUuid(value)) throw new CourtNotFoundError(`That ${what} does not exist.`)
  return value
}

export function readInstant(body: Body, key: string, label: string): Date {
  const value = body[key]
  const instant = typeof value === 'string' ? new Date(value) : undefined
  if (!instant || Number.isNaN(instant.getTime())) throw new CourtInputError(`${label} must be a date and time.`)
  return instant
}

export function plural(count: number, singular: string, many = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : many}`
}

export function formatLocalTime(instant: Date, time_zone: string): string {
  return new Intl.DateTimeFormat('en-PH', { hour: 'numeric', minute: '2-digit', timeZone: time_zone }).format(instant)
}

export function formatLocalDateTime(instant: Date, time_zone: string): string {
  return new Intl.DateTimeFormat('en-PH', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZone: time_zone,
  }).format(instant)
}

/** PostgreSQL SQLSTATE of a thrown driver error, if any. */
export function sqlState(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined
  const code = (error as { code?: unknown }).code
  return typeof code === 'string' ? code : undefined
}
