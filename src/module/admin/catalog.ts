// The module catalog as a venue owner reads it (R03): family, one-sentence
// description, and the dependency plan for enable/disable. Pure — no database.

import type { ModuleDeclaration } from '@bygelo/roundrobin-kernel'

export type ModuleFamily = 'Core' | 'Play' | 'Business' | 'Studio' | 'Connect'

export const MODULE_FAMILY: Record<string, ModuleFamily> = {
  booking: 'Core',
  billing: 'Core',
  court: 'Core',
  portal: 'Core',
  admin: 'Core',
  play: 'Play',
  program: 'Play',
  arrival: 'Play',
  score: 'Play',
  display: 'Play',
  commerce: 'Business',
  shop: 'Business',
  membership: 'Business',
  member: 'Business',
  insight: 'Business',
  studio: 'Studio',
  notification: 'Connect',
  message: 'Connect',
  connector: 'Connect',
  webhook: 'Connect',
  dupr: 'Connect',
  calendar: 'Connect',
  consent: 'Connect',
  output: 'Connect',
  scan: 'Connect',
}

export const FAMILY_ORDER: ModuleFamily[] = ['Core', 'Play', 'Business', 'Studio', 'Connect']

export const MODULE_DESCRIPTION: Record<string, string> = {
  booking: 'Holds, confirms, and cancels court time, and refuses a double booking.',
  billing: 'Invoices, payments, refunds, store credit, and the cash drawer.',
  court: 'Your courts, sports, operating hours, schedule, and the live court board.',
  portal: 'The public booking page where players reserve and pay for a court.',
  admin: 'Staff, roles, modules, API keys, and venue data.',
  play: 'Open play with a rotation queue so everyone gets games.',
  program: 'Clinics, leagues, and classes that players register for.',
  arrival: 'Check-in at the door, with waivers.',
  score: 'Match scores entered courtside and kept as results.',
  display: 'Lounge TVs and court screens that show the board and the queue.',
  commerce: 'The product catalog, stock, and orders behind the shop.',
  shop: 'The counter and online shop: paddles, balls, drinks, and rentals.',
  membership: 'Membership plans and who holds one.',
  member: 'Member passes, session credits, and member pricing.',
  insight: 'Utilisation, revenue, and no-show reports.',
  studio: 'Design and publish your public venue site.',
  notification: 'Email and SMS delivery with player contact preferences.',
  message: 'Booking confirmations, reminders, and other player messages.',
  connector: 'Connections to outside providers, with retries and health.',
  webhook: 'Sends signed events to your own systems when things happen.',
  dupr: 'Links players to DUPR and submits match results.',
  calendar: 'Calendar feeds players and staff can subscribe to.',
  consent: 'Records what players agreed to and handles privacy requests.',
  output: 'Printable and downloadable documents such as receipts.',
  scan: 'QR codes for check-in, courts, and passes.',
}

export function describeModule(one: ModuleDeclaration): string {
  return MODULE_DESCRIPTION[one.module_code] ?? `${one.display_name} module.`
}

export function familyOf(module_code: string): ModuleFamily {
  return MODULE_FAMILY[module_code] ?? 'Connect'
}

/** "Booking", "Booking and Billing", "Booking, Billing, and Court". */
export function joinName(name: string[]): string {
  if (name.length <= 1) return name[0] ?? ''
  if (name.length === 2) return `${name[0]} and ${name[1]}`
  return `${name.slice(0, -1).join(', ')}, and ${name.at(-1)}`
}

/** Enabled modules that directly depend on module_code. */
export function listRequiredBy(
  module_code: string,
  enabled: Set<string>,
  declaration: ModuleDeclaration[],
): ModuleDeclaration[] {
  return declaration.filter((one) => one.depend_on.includes(module_code) && enabled.has(one.module_code))
}

/**
 * Every module that must be enabled, in dependency order, so that module_code
 * can be enabled. Excludes modules already on; ends with module_code itself.
 */
export function planEnable(
  module_code: string,
  enabled: Set<string>,
  declaration: ModuleDeclaration[],
): string[] {
  const by_code = new Map(declaration.map((one) => [one.module_code, one]))
  const order: string[] = []
  const seen = new Set<string>()
  const visit = (code: string) => {
    if (seen.has(code)) return
    seen.add(code)
    for (const each of by_code.get(code)?.depend_on ?? []) visit(each)
    if (!enabled.has(code)) order.push(code)
  }
  visit(module_code)
  return order
}

/** Direct dependencies of module_code that are currently off. */
export function listMissingDependency(
  module_code: string,
  enabled: Set<string>,
  declaration: ModuleDeclaration[],
): ModuleDeclaration[] {
  const one = declaration.find((each) => each.module_code === module_code)
  if (!one) return []
  return one.depend_on
    .filter((each) => !enabled.has(each))
    .map((each) => declaration.find((candidate) => candidate.module_code === each))
    .filter((each): each is ModuleDeclaration => each !== undefined)
}

export function refuseEnableSentence(target: ModuleDeclaration, missing: ModuleDeclaration[]): string {
  const name = joinName(missing.map((one) => one.display_name))
  return `${target.display_name} needs ${name}, which ${missing.length === 1 ? 'is' : 'are'} off. Turn on ${name} first, or turn them on together.`
}

export function refuseDisableSentence(target: ModuleDeclaration, required_by: ModuleDeclaration[]): string {
  const name = joinName(required_by.map((one) => one.display_name))
  return `${target.display_name} cannot be turned off while ${name} ${required_by.length === 1 ? 'uses' : 'use'} it. Turn off ${name} first.`
}

export function refuseCoreSentence(target: ModuleDeclaration): string {
  return `${target.display_name} is part of the core of the venue and cannot be turned off.`
}

export const DATA_KEPT_SENTENCE = 'Nothing is deleted. Its data stays exactly as it is and comes back when you turn it on again.'
