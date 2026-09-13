// Where a webhook may be sent (SSRF guard).
//
// A subscriber URL is typed by a tenant, and the server POSTs to it. Without a
// check, a tenant could point it at the cloud metadata service, the database
// host, or anything else on the private network behind the server. So every
// URL is resolved and refused when ANY resolved address is non-public — on
// create, on update, and again at delivery, because DNS can change after the
// subscription was saved.
//
// Development allowance: WEBHOOK_ALLOW_PRIVATE=true lets a local receiver on
// 127.0.0.1 through (any port). NODE_ENV=production ignores it.

import { lookup as dnsLookup } from 'node:dns/promises'
import { isIP, isIPv4, isIPv6 } from 'node:net'
import { DomainError } from '@bygelo/roundrobin-kernel'

export type LookupAddress = { address: string; family: number }
export type LookupFunction = (hostname: string) => Promise<LookupAddress[]>
export type AddressOption = { env?: NodeJS.ProcessEnv; lookup?: LookupFunction }

export type AddressReasonCode = 'invalid' | 'credential' | 'protocol' | 'port' | 'private_address' | 'unresolved'

export const ADDRESS_NOT_ALLOWED_SENTENCE =
  'That address is on a private or internal network, so events cannot be sent there. Use a public https:// address.'
export const PORT_NOT_ALLOWED_SENTENCE =
  'Webhook URLs must use the standard port (443 for https, 80 for http). Remove the port from the address.'
export const PROTOCOL_SENTENCE =
  'Webhook URLs must use https://. Plain http is allowed only for localhost during development.'
export const UNRESOLVED_SENTENCE = 'We could not find that host. Check the address and try again.'

/** Stable prefix of a delivery's last_error when the address was refused; the subscription list keys on it. */
export const ADDRESS_REFUSED_PREFIX = 'Not sent — address not allowed:'

export class WebhookAddressError extends DomainError {
  readonly reason_code: AddressReasonCode
  constructor(message: string, reason_code: AddressReasonCode) {
    super(message, 400)
    this.reason_code = reason_code
  }
  /** Only a DNS miss may be temporary; every other refusal will refuse again. */
  get is_retryable(): boolean {
    return this.reason_code === 'unresolved'
  }
}

export function isPrivateAllowed(env: NodeJS.ProcessEnv = process.env): boolean {
  return env['WEBHOOK_ALLOW_PRIVATE'] === 'true' && env['NODE_ENV'] !== 'production'
}

// ---------------------------------------------------------------------------
// address classification (pure)
// ---------------------------------------------------------------------------

function parseIpv4(text: string): number | null {
  if (!isIPv4(text)) return null
  return text.split('.').reduce((value, part) => (value * 256 + Number(part)) >>> 0, 0)
}

const IPV4_BLOCK: { base: string; prefix: number; label: string }[] = [
  { base: '0.0.0.0', prefix: 8, label: 'unspecified' },
  { base: '10.0.0.0', prefix: 8, label: 'private' },
  { base: '100.64.0.0', prefix: 10, label: 'carrier-grade NAT' },
  { base: '127.0.0.0', prefix: 8, label: 'loopback' },
  { base: '169.254.0.0', prefix: 16, label: 'link-local' },
  { base: '172.16.0.0', prefix: 12, label: 'private' },
  { base: '192.0.0.0', prefix: 24, label: 'reserved' },
  { base: '192.0.2.0', prefix: 24, label: 'documentation' },
  { base: '192.168.0.0', prefix: 16, label: 'private' },
  { base: '198.18.0.0', prefix: 15, label: 'benchmark' },
  { base: '198.51.100.0', prefix: 24, label: 'documentation' },
  { base: '203.0.113.0', prefix: 24, label: 'documentation' },
  { base: '224.0.0.0', prefix: 4, label: 'multicast' },
  { base: '240.0.0.0', prefix: 4, label: 'reserved' },
]

function classifyIpv4Number(value: number): string | null {
  for (const block of IPV4_BLOCK) {
    const mask = block.prefix === 0 ? 0 : (0xffffffff << (32 - block.prefix)) >>> 0
    if (((value & mask) >>> 0) === ((parseIpv4(block.base)! & mask) >>> 0)) return block.label
  }
  return null
}

/** Eight 16-bit groups, or null when the text is not IPv6. Accepts a zone id and a dotted IPv4 tail. */
function parseIpv6(text: string): number[] | null {
  let value = text.split('%')[0] ?? ''
  if (!isIPv6(value)) return null
  const last_colon = value.lastIndexOf(':')
  const tail = value.slice(last_colon + 1)
  if (tail.includes('.')) {
    const v4 = parseIpv4(tail)
    if (v4 === null) return null
    value = `${value.slice(0, last_colon + 1)}${(v4 >>> 16).toString(16)}:${(v4 & 0xffff).toString(16)}`
  }
  const [head_text, rest_text] = value.split('::') as [string, string | undefined]
  const head = head_text ? head_text.split(':') : []
  const rest = rest_text === undefined ? [] : rest_text ? rest_text.split(':') : []
  const fill = rest_text === undefined ? 0 : 8 - head.length - rest.length
  const group = [...head, ...Array<string>(fill).fill('0'), ...rest].map((one) => parseInt(one, 16))
  return group.length === 8 && group.every((one) => Number.isInteger(one) && one >= 0 && one <= 0xffff) ? group : null
}

function embeddedIpv4(high: number, low: number): number {
  return ((high << 16) | low) >>> 0
}

function classifyIpv6(group: number[]): string | null {
  const [g0, g1, g2, g3, g4, g5, g6, g7] = group as [number, number, number, number, number, number, number, number]
  const is_zero_prefix = g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0
  if (is_zero_prefix && g5 === 0 && g6 === 0 && g7 === 0) return 'unspecified'
  if (is_zero_prefix && g5 === 0 && g6 === 0 && g7 === 1) return 'loopback'
  if (is_zero_prefix && g5 === 0xffff) return classifyIpv4Number(embeddedIpv4(g6, g7)) ?? null // ::ffff:a.b.c.d
  if (is_zero_prefix && g5 === 0) return 'IPv4-compatible' // deprecated ::a.b.c.d
  if (g0 === 0x64 && g1 === 0xff9b && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0) {
    return classifyIpv4Number(embeddedIpv4(g6, g7)) // NAT64
  }
  if (g0 === 0x2002) return classifyIpv4Number(embeddedIpv4(g1, g2)) // 6to4
  if ((g0 & 0xfe00) === 0xfc00) return 'unique local'
  if ((g0 & 0xffc0) === 0xfe80) return 'link-local'
  if ((g0 & 0xffc0) === 0xfec0) return 'site-local'
  if ((g0 & 0xff00) === 0xff00) return 'multicast'
  if (g0 === 0x2001 && g1 === 0x0db8) return 'documentation'
  return null
}

/**
 * Why an address is not public ("loopback", "private", "link-local", …), or
 * null when it is a public unicast address. Anything unparseable is refused.
 */
export function classifyAddress(address: string): string | null {
  const bare = address.replace(/^\[|\]$/g, '')
  const v4 = parseIpv4(bare)
  if (v4 !== null) return classifyIpv4Number(v4)
  const v6 = parseIpv6(bare)
  if (v6 !== null) return classifyIpv6(v6)
  return 'not an IP address'
}

// ---------------------------------------------------------------------------
// URL check
// ---------------------------------------------------------------------------

const defaultLookup: LookupFunction = (hostname) => dnsLookup(hostname, { all: true, verbatim: true })

const LOCAL_HOSTNAME = new Set(['localhost', '127.0.0.1', '[::1]'])

/** Shape rules only — no DNS. Returns the parsed URL. */
export function parseWebhookUrl(url: unknown, option: AddressOption = {}): URL {
  if (typeof url !== 'string' || !url.trim()) throw new WebhookAddressError('Enter the URL that should receive events.', 'invalid')
  let parsed: URL
  try {
    parsed = new URL(url.trim())
  } catch {
    throw new WebhookAddressError('That is not a valid URL. Use a full address such as https://example.com/hook.', 'invalid')
  }
  if (parsed.username || parsed.password) {
    throw new WebhookAddressError(
      'Do not put a username or password in the webhook URL; verify the signature instead.',
      'credential',
    )
  }
  const is_allowed = isPrivateAllowed(option.env)
  const is_local = LOCAL_HOSTNAME.has(parsed.hostname)
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && is_local && is_allowed)) {
    throw new WebhookAddressError(PROTOCOL_SENTENCE, 'protocol')
  }
  if (!is_allowed && parsed.port !== '' && parsed.port !== '443' && parsed.port !== '80') {
    throw new WebhookAddressError(PORT_NOT_ALLOWED_SENTENCE, 'port')
  }
  return parsed
}

/**
 * The full check: shape, then every resolved address must be public (unless
 * the development allowance applies). Returns the normalized URL.
 */
export async function assertWebhookTarget(url: unknown, option: AddressOption = {}): Promise<string> {
  const parsed = parseWebhookUrl(url, option)
  if (isPrivateAllowed(option.env)) return parsed.toString()

  const hostname = parsed.hostname.replace(/^\[|\]$/g, '')
  let resolved: LookupAddress[]
  if (isIP(hostname)) {
    resolved = [{ address: hostname, family: isIP(hostname) }]
  } else {
    try {
      resolved = await (option.lookup ?? defaultLookup)(hostname)
    } catch {
      throw new WebhookAddressError(UNRESOLVED_SENTENCE, 'unresolved')
    }
    if (resolved.length === 0) throw new WebhookAddressError(UNRESOLVED_SENTENCE, 'unresolved')
  }
  if (resolved.some((one) => classifyAddress(one.address) !== null)) {
    throw new WebhookAddressError(ADDRESS_NOT_ALLOWED_SENTENCE, 'private_address')
  }
  return parsed.toString()
}
