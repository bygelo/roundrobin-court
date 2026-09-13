// Small HTTP helpers shared by the program and arrival routes.

import type { Context } from 'hono'
import type { WaiverEvidence } from '../arrival/service.ts'

/** The JSON body as a plain object; anything else (bad JSON, an array) reads as empty. */
export async function readBody(context: Context): Promise<Record<string, unknown>> {
  const body = (await context.req.json().catch(() => null)) as unknown
  return typeof body === 'object' && body !== null && !Array.isArray(body) ? (body as Record<string, unknown>) : {}
}

/** Waiver evidence from the request: user agent and the caller's address, hashed later. */
export function readEvidence(context: Context): WaiverEvidence {
  const forwarded = context.req.header('x-forwarded-for')?.split(',')[0]?.trim()
  return {
    user_agent: context.req.header('user-agent')?.slice(0, 400) ?? null,
    address: forwarded || context.req.header('x-real-ip') || null,
  }
}

export function notFound(context: Context) {
  return context.json({ error: 'not found' }, 404)
}
