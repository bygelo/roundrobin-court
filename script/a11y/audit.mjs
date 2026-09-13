// Repeatable WCAG 2.2 AA audit over the Chrome DevTools Protocol (R30).
//
// For every scoped screen at 375 and 1280 it injects axe-core, runs the WCAG
// 2.0/2.1/2.2 A+AA rules, then drives the keyboard: a Tab walk that flags focus
// with no visible indicator or hidden under a sticky bar (2.4.11), the ARIA tab
// pattern (arrow keys), and — for the main dialogs — focus moves in, stays in,
// Escape closes, focus returns to the opener. A 320px pass checks reflow (1.4.10).
//
// axe-core is NOT a repo dependency. Install it anywhere and point AXE_PATH at
// axe.min.js:
//   npm install axe-core --prefix <somewhere>
//   AXE_PATH=<somewhere>/node_modules/axe-core/axe.min.js ORIGIN=http://localhost:8834 node script/a11y/audit.mjs [route-regex]
//
// Needs a seeded venue `sideout` with staff `operator` / `correct-horse`.

import { spawn } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const ORIGIN = process.env['ORIGIN'] ?? 'http://localhost:8834'
const AXE_PATH = process.env['AXE_PATH']
const CHROME = process.env['CHROME'] ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const OUT = process.env['A11Y_OUT'] ?? join(tmpdir(), 'court-a11y')
const CDP_PORT = Number(process.env['CDP_PORT'] ?? 9434)
const ONLY = process.argv[2] ? new RegExp(process.argv[2]) : null
if (!AXE_PATH) {
  console.error('AXE_PATH must point at axe.min.js (axe-core is not a repo dependency).')
  process.exit(1)
}
const AXE_SOURCE = readFileSync(AXE_PATH, 'utf8')
mkdirSync(OUT, { recursive: true })

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function findDeep(value, test, depth = 0) {
  if (depth > 8 || value === null || typeof value !== 'object') return undefined
  if (test(value)) return value
  for (const child of Array.isArray(value) ? value : Object.values(value)) {
    const hit = findDeep(child, test, depth + 1)
    if (hit !== undefined) return hit
  }
  return undefined
}

async function api(path, init = {}, token) {
  const response = await fetch(`${ORIGIN}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...(init.headers ?? {}) },
  })
  const text = await response.text()
  let body
  try {
    body = JSON.parse(text)
  } catch {
    body = text
  }
  return { status: response.status, body }
}

// ---- data the audit needs -------------------------------------------------
const signed = await api('/api/v1/session', {
  method: 'POST',
  body: JSON.stringify({ organization_code: 'sideout', actor_code: 'operator', secret: 'correct-horse' }),
})
const token = signed.body.token
if (!token) throw new Error(`sign-in failed: ${JSON.stringify(signed)}`)

const play = await api('/api/v1/play/session', {}, token)
const play_token = findDeep(play.body, (one) => typeof one.public_token === 'string')?.public_token

const court_list = await api('/api/v1/court/court', {}, token)
const resource_id = findDeep(court_list.body, (one) => typeof one.resource_id === 'string')?.resource_id
const credential = {}
for (const kind of ['court', 'lounge', 'counter', 'kiosk']) {
  const made = await api(
    '/api/v1/display/screen',
    { method: 'POST', body: JSON.stringify({ kind, display_name: `Audit ${kind} ${Date.now()}`, ...(kind === 'court' ? { resource_id } : {}) }) },
    token,
  )
  const one = findDeep(made.body, (value) => typeof value.credential === 'string')?.credential
  if (one) credential[kind] = one
  else console.log(`display ${kind} refused:`, made.status, JSON.stringify(made.body).slice(0, 160))
}

let recovery
let booked_date
for (const offset_hour of [36, 60, 84]) {
  if (recovery) break
  const day = new Date(Date.now() + offset_hour * 3600 * 1000).toISOString().slice(0, 10)
  const availability = await api(`/public/sideout/portal/availability?date=${day}`)
  const slot = findDeep(availability.body, (one) => one.is_available === true && one.session_id && one.resource_id)
  if (!slot) continue
  const booked = await api('/public/sideout/portal/booking', {
    method: 'POST',
    body: JSON.stringify({
      session_id: slot.session_id,
      resource_id: slot.resource_id,
      participant_count: 4,
      contact: { display_name: 'Audit Tester', email: 'audit.tester@example.com', phone: '09170000000' },
    }),
  })
  if (booked.body.booking_code) {
    booked_date = day
    recovery =`/v/sideout/booking/${booked.body.booking_code}?token=${encodeURIComponent(booked.body.recovery_token)}`
  }
}
console.log(JSON.stringify({ play_token: Boolean(play_token), credential: Object.keys(credential), recovery: Boolean(recovery) }))

// A dialog flow: the route, then how to open the dialog.
// `prepare` runs in the page first (pick a day with open slots, point the list at the booked day).
const SET_DATE = (day) => `(async () => {
  const input = document.querySelector('input[type=date]')
  if (!input) return false
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, ${JSON.stringify(day ?? '')})
  input.dispatchEvent(new Event('input', { bubbles: true }))
  await new Promise((resolve) => setTimeout(resolve, 1500))
  return true
})()`
const PICK_OPEN_DAY = `(async () => {
  const open = () => [...document.querySelectorAll('.slot-cell:not([disabled]), .court-chip:not([disabled])')].some((el) => el.getClientRects().length > 0)
  const day = [...document.querySelectorAll('.date-strip__day')]
  for (const one of day) {
    if (open()) return true
    one.click()
    await new Promise((resolve) => setTimeout(resolve, 1200))
  }
  return open()
})()`
const DIALOG = [
  { dialog_code: 'booking-checkout', route: '/v/sideout', prepare: () => PICK_OPEN_DAY, opener: { selector: '.slot-cell:not([disabled]), .court-chip:not([disabled])', visible: true } },
  { dialog_code: 'record-payment', route: '/operator/booking', prepare: () => SET_DATE(booked_date), opener: { text: /^Record payment$/ } },
  { dialog_code: 'add-staff', route: '/operator/staff', opener: { text: /^Add staff$/ } },
  { dialog_code: 'new-match', route: '/operator/score', opener: { text: /^New match$/ } },
  { dialog_code: 'add-screen', route: '/operator/display', opener: { text: /^Add (a )?screen$/ } },
  { dialog_code: 'create-program', route: '/operator/program', opener: { text: /^(New program|Create a program)$/ } },
]

const ROUTE = [
  '/v/sideout',
  ...(recovery ? [recovery] : []),
  '/v/sideout/program',
  '/v/sideout/shop',
  '/v/sideout/privacy',
  ...(play_token ? [`/play/${play_token}`] : []),
  ...Object.entries(credential).map(([kind, one]) => `/display?credential=${encodeURIComponent(one)}#${kind}`),
  '/sign-in',
  '/no-such-page',
  '/operator/board',
  '/operator/booking',
  '/operator/arrival',
  '/operator/play',
  '/operator/program',
  '/operator/score',
  '/operator/display',
  '/operator/shop',
  '/operator/member',
  '/operator/insight',
  '/operator/venue',
  '/operator/studio',
  '/operator/message',
  '/operator/connect',
  '/operator/staff',
  '/operator/module',
  '/operator/developer',
  '/operator/data',
  '/operator/account',
].filter((route) => !ONLY || ONLY.test(route))

// ---- chrome ---------------------------------------------------------------
const chrome = spawn(
  CHROME,
  [
    '--headless=new',
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${join(OUT, 'profile')}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--hide-scrollbars',
    'about:blank',
  ],
  { stdio: 'ignore' },
)

let target
for (let attempt = 0; attempt < 50 && !target; attempt += 1) {
  try {
    const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json()
    target = list.find((one) => one.type === 'page')
  } catch {
    await sleep(200)
  }
}
if (!target) throw new Error('chrome did not start')

const socket = new WebSocket(target.webSocketDebuggerUrl)
await new Promise((resolve) => socket.addEventListener('open', resolve, { once: true }))
let sequence = 0
const pending = new Map()
socket.addEventListener('message', (event) => {
  const message = JSON.parse(event.data)
  if (message.id && pending.has(message.id)) {
    pending.get(message.id)(message)
    pending.delete(message.id)
  } else if (message.method === 'Page.javascriptDialogOpening') {
    console.log(`  js dialog dismissed: ${message.params.type} ${message.params.message.slice(0, 80)}`)
    void send('Page.handleJavaScriptDialog', { accept: true })
  }
})
// Every call has a ceiling, so a hung page reports instead of stalling the audit.
const send = (method, params = {}) =>
  new Promise((resolve) => {
    sequence += 1
    const id = sequence
    const timer = setTimeout(() => {
      pending.delete(id)
      console.log(`  CDP timeout: ${method} ${JSON.stringify(params).slice(0, 80)}`)
      resolve({ result: { exceptionDetails: { exception: { description: `timeout ${method}` } } } })
    }, 20_000)
    pending.set(id, (message) => {
      clearTimeout(timer)
      resolve(message)
    })
    socket.send(JSON.stringify({ id, method, params }))
  })
const evaluate = async (expression) => {
  const reply = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  if (reply.result?.exceptionDetails) {
    console.log(`  evaluate failed: ${(reply.result.exceptionDetails.exception?.description ?? 'unknown').slice(0, 160)}`)
    return undefined
  }
  return reply.result?.result?.value
}
const key = async (name, modifier = 0) => {
  const code = { Tab: 9, Escape: 27, ArrowRight: 39, ArrowLeft: 37, Home: 36, End: 35, Enter: 13 }[name]
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: name, code: name, windowsVirtualKeyCode: code, modifiers: modifier, ...(name === 'Enter' ? { text: '\r' } : {}) })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: name, code: name, windowsVirtualKeyCode: code, modifiers: modifier })
  await sleep(40)
}

await send('Page.enable')
await send('Runtime.enable')
await send('Page.navigate', { url: `${ORIGIN}/sign-in` })
await sleep(1500)
await evaluate(
  `localStorage.setItem('court.session', ${JSON.stringify(JSON.stringify({ token, organization_code: 'sideout', actor_code: 'operator' }))}); true`,
)

const AXE_RUN = `(async () => {
  if (!window.axe) { ${AXE_SOURCE}\n }
  const result = await window.axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22a', 'wcag22aa', 'best-practice'] }, resultTypes: ['violations'] })
  return result.violations.map((one) => ({ id: one.id, impact: one.impact, is_wcag: one.tags.some((tag) => /^wcag2/.test(tag)), help: one.help, node: one.nodes.slice(0, 4).map((node) => ({ target: node.target.join(' '), summary: (node.failureSummary || '').slice(0, 240) })), node_count: one.nodes.length }))
})()`

// Describe the focused element: a visible indicator, and whether a sticky/fixed
// bar covers it entirely.
const FOCUS_FACT = `(() => {
  const el = document.activeElement
  if (!el || el === document.body) return null
  const rect = el.getBoundingClientRect()
  const style = getComputedStyle(el)
  const has_outline = style.outlineStyle !== 'none' && parseFloat(style.outlineWidth) > 0
  const has_shadow = style.boxShadow && style.boxShadow !== 'none'
  const point = [[rect.left + rect.width / 2, rect.top + rect.height / 2], [rect.left + 2, rect.top + 2], [rect.right - 2, rect.bottom - 2], [rect.left + 2, rect.bottom - 2], [rect.right - 2, rect.top + 2]]
  let visible_point = 0
  for (const [x, y] of point) {
    if (x < 0 || y < 0 || x > innerWidth || y > innerHeight) continue
    const top = document.elementFromPoint(x, y)
    if (top && (top === el || el.contains(top) || top.contains(el))) visible_point += 1
  }
  const label = (el.getAttribute('aria-label') || el.innerText || el.getAttribute('name') || el.id || '').trim().slice(0, 40)
  return { tag: el.tagName.toLowerCase(), label, has_indicator: has_outline || Boolean(has_shadow), is_obscured: rect.width > 0 && visible_point === 0, is_zero: rect.width === 0 || rect.height === 0 }
})()`

async function tabWalk(limit = 70) {
  const issue = []
  const seen = new Set()
  await evaluate(`document.activeElement && document.activeElement.blur(); window.scrollTo(0, 0); true`)
  for (const modifier of [0, 8]) {
    for (let step = 0; step < limit; step += 1) {
      await key('Tab', modifier)
      const fact = await evaluate(FOCUS_FACT)
      if (!fact) continue
      const name = `${fact.tag}:${fact.label}`
      if (!fact.has_indicator) issue.push(`no-indicator ${name}`)
      if (fact.is_obscured && !fact.is_zero) issue.push(`obscured ${name}`)
      if (seen.has(`${modifier}${name}`) && step > 5) break
      seen.add(`${modifier}${name}`)
    }
  }
  return [...new Set(issue)]
}

async function tabPattern() {
  return evaluate(`(async () => {
    const list = [...document.querySelectorAll('[role=tablist]')]
    const out = []
    for (const [list_index, tablist] of list.entries()) {
      const tab = [...tablist.querySelectorAll('[role=tab]')]
      if (tab.length < 2) continue
      const selected = tab.find((one) => one.getAttribute('aria-selected') === 'true') || tab[0]
      const roving = tab.filter((one) => one !== selected).every((one) => one.tabIndex === -1)
      const controls = tab.every((one) => one.hasAttribute('aria-controls') ? document.getElementById(one.getAttribute('aria-controls')) : true)
      out.push({ label: tablist.getAttribute('aria-label'), roving, controls, index: tab.indexOf(selected), list_index })
    }
    return out
  })()`)
}

async function arrowCheck() {
  const list = (await tabPattern()) ?? []
  const result = []
  for (let index = 0; index < list.length; index += 1) {
    await evaluate(`(() => { const tablist = document.querySelectorAll('[role=tablist]')[${list[index].list_index}]; if (!tablist) return false; const tab = [...tablist.querySelectorAll('[role=tab]')]; (tab.find((one) => one.getAttribute('aria-selected') === 'true') || tab[0]).focus(); return true })()`)
    const before = await evaluate(`document.activeElement.textContent`)
    await key('ArrowRight')
    await sleep(150)
    const after = (await evaluate(`({ text: document.activeElement.textContent, role: document.activeElement.getAttribute('role') })`)) ?? {}
    result.push({ ...list[index], arrow_moves: after.role === 'tab' && after.text !== before })
    // Put the selection back, so a later tablist that lives inside this tab's panel still exists.
    await key('ArrowLeft')
    await sleep(600)
  }
  return result
}

async function openDialog(opener) {
  const is_found = await evaluate(`(() => {
    const visible = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden' }
    let el
    ${opener.selector ? `el = [...document.querySelectorAll(${JSON.stringify(opener.selector)})].find(visible)` : ''}
    ${opener.text ? `el = [...document.querySelectorAll('button, a')].find((one) => ${opener.text}.test(one.textContent.trim()) && visible(one) && !one.disabled)` : ''}
    if (!el) return false
    el.setAttribute('data-audit-opener', '1')
    el.scrollIntoView({ block: 'center' })
    el.focus()
    return true
  })()`)
  if (!is_found) return false
  await key('Enter')
  await sleep(900)
  return true
}

async function dialogCheck() {
  const fact = {}
  fact.is_open = await evaluate(`Boolean(document.querySelector('[role=dialog]'))`)
  if (!fact.is_open) return fact
  fact.name = await evaluate(`(() => { const d = document.querySelector('[role=dialog]'); const id = d.getAttribute('aria-labelledby'); return id ? document.getElementById(id)?.textContent : d.getAttribute('aria-label') })()`)
  fact.focus_moved_in = await evaluate(`document.querySelector('[role=dialog]').contains(document.activeElement)`)
  let is_trapped = true
  for (let step = 0; step < 40; step += 1) {
    await key('Tab', step % 3 === 2 ? 8 : 0)
    if (!(await evaluate(`Boolean(document.querySelector('[role=dialog]')?.contains(document.activeElement))`))) {
      is_trapped = false
      break
    }
  }
  fact.is_trapped = is_trapped
  return fact
}

async function dialogClose(fact) {
  await key('Escape')
  await sleep(400)
  fact.escape_closes = !(await evaluate(`Boolean(document.querySelector('[role=dialog]'))`))
  fact.focus_returned = await evaluate(`document.activeElement?.getAttribute('data-audit-opener') === '1'`)
  return fact
}

// The tally counts WCAG A/AA rules only; best-practice findings (heading order,
// landmarks) are listed after a `bp:` marker and do not affect the pass bar.
const count = (violation) => {
  const tally = { critical: 0, serious: 0, moderate: 0, minor: 0, best_practice: 0 }
  for (const one of violation) {
    if (one.is_wcag) tally[one.impact] = (tally[one.impact] ?? 0) + 1
    else tally.best_practice += 1
  }
  return tally
}
const label = (violation) =>
  [...violation.filter((v) => v.is_wcag), ...violation.filter((v) => !v.is_wcag)]
    .map((v) => `${v.is_wcag ? '' : 'bp:'}${v.id}(${v.impact[0]}${v.node_count})`)
    .join(' ')

const summary = []
const WIDTH = (process.env['A11Y_WIDTH'] ?? '375,1280').split(',').map(Number)
for (const width of WIDTH) {
  await send('Emulation.setDeviceMetricsOverride', { width, height: width < 500 ? 812 : 900, deviceScaleFactor: 1, mobile: width < 500 })
  for (const route of ROUTE) {
    console.error(`… ${width} ${route.slice(0, 40)}`)
    await send('Page.navigate', { url: `${ORIGIN}${route}` })
    await sleep(2800)
    const violation = (await evaluate(AXE_RUN)) ?? []
    const tab = await arrowCheck()
    const focus = await tabWalk()
    const record = { width, route: route.replace(/(token=|credential=)[^&#]+/, '$1…').replace(/\/play\/[^/?#]+/, '/play/:token').replace(/\/booking\/[^/?#]+/, '/booking/:code'), tally: count(violation), violation, tab, focus }

    const flow = DIALOG.find((one) => one.route === route)
    if (flow) {
      await send('Page.navigate', { url: `${ORIGIN}${route}` })
      await sleep(2800)
      if (flow.prepare) await evaluate(flow.prepare())
      if (await openDialog(flow.opener)) {
        const dialog = await dialogCheck()
        const dialog_violation = dialog.is_open ? ((await evaluate(AXE_RUN)) ?? []) : []
        if (dialog.is_open) await dialogClose(dialog)
        record.dialog = { dialog_code: flow.dialog_code, ...dialog, tally: count(dialog_violation), violation: dialog_violation }
      } else {
        record.dialog = { dialog_code: flow.dialog_code, is_opener_missing: true }
      }
    }
    summary.push(record)
  }
}

// Shell keyboard checks at 375: the skip link is the first stop, is visible, and
// moves focus to <main>; each mobile menu toggle exposes its state, moves focus
// into the menu, and Escape returns focus to the toggle.
const shell = []
await send('Emulation.setDeviceMetricsOverride', { width: 375, height: 812, deviceScaleFactor: 1, mobile: true })
for (const [route, toggle] of [['/operator/board', '.operator__menu'], ['/v/sideout', '.public__menu']]) {
  await send('Page.navigate', { url: `${ORIGIN}${route}` })
  await sleep(2800)
  await evaluate(`document.activeElement && document.activeElement.blur(); true`)
  await key('Tab')
  const skip = await evaluate(`(() => { const el = document.activeElement; const r = el.getBoundingClientRect(); return { is_skip: el.classList.contains('skip-link'), is_visible: r.top >= 0 && r.height > 0 } })()`)
  await key('Enter')
  await sleep(300)
  skip.moves_to_main = await evaluate(`document.activeElement?.id === 'main'`)
  await evaluate(`document.querySelector(${JSON.stringify(toggle)}).focus(); true`)
  await key('Enter')
  await sleep(500)
  const menu = await evaluate(`(() => { const t = document.querySelector(${JSON.stringify(toggle)}); const nav = document.getElementById(t.getAttribute('aria-controls')); return { is_expanded: t.getAttribute('aria-expanded') === 'true', focus_in_menu: Boolean(nav && nav.contains(document.activeElement)) } })()`)
  await key('Escape')
  await sleep(400)
  Object.assign(menu, await evaluate(`(() => { const t = document.querySelector(${JSON.stringify(toggle)}); return { collapsed_on_escape: t.getAttribute('aria-expanded') === 'false', focus_returned: document.activeElement === t } })()`))
  shell.push({ route, skip, menu })
}

// Reflow at 320 CSS px (= 1280 at 400%).
await send('Emulation.setDeviceMetricsOverride', { width: 320, height: 640, deviceScaleFactor: 1, mobile: true })
const reflow = []
for (const route of ROUTE) {
  await send('Page.navigate', { url: `${ORIGIN}${route}` })
  await sleep(2500)
  const fact = await evaluate(`(() => {
    const exempt = (el) => Boolean(el.closest('.table-wrap, table, .court-timeline, .court-board__scroll, [data-reflow-exempt]'))
    const wide = [...document.querySelectorAll('body *')].filter((el) => {
      const r = el.getBoundingClientRect()
      if (r.width === 0 || getComputedStyle(el).position === 'fixed') return false
      let parent = el.parentElement, clipped = false
      while (parent && parent !== document.body) { const o = getComputedStyle(parent).overflowX; if (o === 'auto' || o === 'scroll' || o === 'hidden') { clipped = true; break } parent = parent.parentElement }
      return r.right > innerWidth + 1 && !clipped && !exempt(el)
    }).slice(0, 4).map((el) => el.tagName.toLowerCase() + (typeof el.className === 'string' && el.className ? '.' + el.className.split(' ')[0] : ''))
    return { overflow_px: document.documentElement.scrollWidth - innerWidth, wide }
  })()`)
  reflow.push({ route: route.replace(/(token=|credential=)[^&#]+/, '$1…').replace(/\/play\/[^/?#]+/, '/play/:token').replace(/\/booking\/[^/?#]+/, '/booking/:code'), ...fact })
}

writeFileSync(join(OUT, 'a11y-result.json'), JSON.stringify({ summary, shell, reflow }, null, 2))
for (const one of shell) console.log(`shell ${one.route}: skip ${JSON.stringify(one.skip)} menu ${JSON.stringify(one.menu)}`)
let blocking = 0
for (const one of summary) {
  const t = one.tally
  blocking += t.critical + t.serious
  const id = label(one.violation)
  console.log(`${String(one.width).padEnd(5)} ${one.route.padEnd(44)} c${t.critical} s${t.serious} m${t.moderate} ${id}`)
  if (one.focus.length) console.log(`      focus: ${one.focus.slice(0, 6).join(' | ')}`)
  const bad_tab = one.tab.filter((tab) => !tab.arrow_moves || !tab.roving)
  if (bad_tab.length) console.log(`      tabs: ${JSON.stringify(bad_tab)}`)
  if (one.dialog) {
    const d = one.dialog
    if (d.is_opener_missing) console.log(`      dialog ${d.dialog_code}: opener not found`)
    else {
      blocking += (d.tally?.critical ?? 0) + (d.tally?.serious ?? 0)
      console.log(`      dialog ${d.dialog_code}: open=${d.is_open} name=${JSON.stringify(d.name)} in=${d.focus_moved_in} trap=${d.is_trapped} esc=${d.escape_closes} return=${d.focus_returned} c${d.tally.critical} s${d.tally.serious} m${d.tally.moderate} ${label(d.violation)}`)
    }
  }
}
for (const one of reflow) if (one.overflow_px > 0 || one.wide.length) console.log(`reflow320 ${one.route}: overflow ${one.overflow_px}px ${one.wide.join(',')}`)
console.log(`critical+serious total: ${blocking}  → ${join(OUT, 'a11y-result.json')}`)
socket.close()
chrome.kill()
process.exit(blocking === 0 ? 0 : 1)
