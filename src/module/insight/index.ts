// insight — R16 owner insight and accounting export.
//
// roundrobin reports and exports; it does not keep a ledger. Every figure is
// derived at read time (see service.ts for the definitions) and the journal
// export is a file an accountant imports into their own books.
//
//   GET  /api/v1/insight/summary?from=&to=            KPIs, revenue by source, occupancy, alerts
//   GET  /api/v1/insight/daily?from=&to=              per-day bookings, court-hours, revenue
//   GET  /api/v1/insight/export.csv?from=&to=&kind=   booking | revenue | occupancy
//   GET  /api/v1/insight/journal.csv?from=&to=        balanced journal entries
//   GET  /api/v1/insight/account                      the account mapping the journal posts to
//   POST /api/v1/insight/revenue-tag                  classify an invoice or payment (insight.manage)

import { authorize, DomainError, type KernelApp, type ModuleDeclaration, type RouteContributor, type Store } from '@bygelo/roundrobin-kernel'
import { JOURNAL_ACCOUNT, REVENUE_SOURCE, isSourceCode } from './csv.ts'
import { tagRevenueSource } from './source.ts'
import { EXPORT_KIND, buildDaily, buildSummary, exportCsv, exportJournalCsv, resolveWindow, type ExportKind, type InsightWindow } from './service.ts'

export const INSIGHT_MODULE: ModuleDeclaration = {
  module_code: 'insight',
  package_code: 'court',
  display_name: 'Insight',
  schema_version: 1,
  is_removable: true,
  depend_on: ['court', 'booking'],
  capability: [
    { capability_code: 'insight.read', description: 'See venue insight and download reports and the accounting journal' },
    { capability_code: 'insight.manage', description: 'Classify which line of business a payment or invoice belongs to' },
  ],
  route_prefix: ['/api/v1/insight'],
}

function csvResponse(csv: string, filename: string): Response {
  return new Response(csv, {
    status: 200,
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="${filename}"`,
      'cache-control': 'no-store',
    },
  })
}

function rangeName(window: InsightWindow): string {
  return window.from === window.to ? window.from : `${window.from}-to-${window.to}`
}

export function createInsightRoute(_store: Store): RouteContributor {
  return (app: KernelApp) => {
    app.get('/api/v1/insight/summary', async (context) => {
      authorize(context.get('session'), 'insight.read')
      const tenant = context.get('tenant')
      const window = await resolveWindow(tenant, { from: context.req.query('from'), to: context.req.query('to') })
      return context.json(await buildSummary(tenant, window))
    })

    app.get('/api/v1/insight/daily', async (context) => {
      authorize(context.get('session'), 'insight.read')
      const tenant = context.get('tenant')
      const window = await resolveWindow(tenant, { from: context.req.query('from'), to: context.req.query('to') })
      return context.json(await buildDaily(tenant, window))
    })

    app.get('/api/v1/insight/export.csv', async (context) => {
      authorize(context.get('session'), 'insight.read')
      const kind = context.req.query('kind') ?? 'booking'
      if (!EXPORT_KIND.includes(kind as ExportKind)) {
        throw new DomainError(`kind must be one of ${EXPORT_KIND.join(', ')}`, 400)
      }
      const tenant = context.get('tenant')
      const window = await resolveWindow(tenant, { from: context.req.query('from'), to: context.req.query('to') })
      const csv = await exportCsv(tenant, window, kind as ExportKind)
      return csvResponse(csv, `insight-${kind}-${rangeName(window)}.csv`)
    })

    app.get('/api/v1/insight/journal.csv', async (context) => {
      authorize(context.get('session'), 'insight.read')
      const tenant = context.get('tenant')
      const window = await resolveWindow(tenant, { from: context.req.query('from'), to: context.req.query('to') })
      const csv = await exportJournalCsv(tenant, window)
      return csvResponse(csv, `journal-${rangeName(window)}.csv`)
    })

    app.get('/api/v1/insight/account', (context) => {
      authorize(context.get('session'), 'insight.read')
      return context.json({ account: JOURNAL_ACCOUNT, source: REVENUE_SOURCE })
    })

    app.post('/api/v1/insight/revenue-tag', async (context) => {
      authorize(context.get('session'), 'insight.manage')
      const body = (await context.req.json().catch(() => null)) as
        | { invoice_code?: unknown; payment_code?: unknown; source_code?: unknown }
        | null
      if (!body || typeof body !== 'object') throw new DomainError('a JSON body is required', 400)
      if (!isSourceCode(body.source_code)) {
        throw new DomainError(`source_code must be one of ${REVENUE_SOURCE.map((one) => one.source_code).join(', ')}`, 400)
      }
      const invoice_code = typeof body.invoice_code === 'string' ? body.invoice_code.trim() : ''
      const payment_code = typeof body.payment_code === 'string' ? body.payment_code.trim() : ''
      if ((invoice_code === '') === (payment_code === '')) {
        throw new DomainError('give exactly one of invoice_code or payment_code', 400)
      }
      const tenant = context.get('tenant')
      const revenue_tag = await tagRevenueSource(tenant, {
        ...(invoice_code ? { invoice_code } : { payment_code }),
        source_code: body.source_code,
      })
      return context.json({ revenue_tag })
    })
  }
}
