// Revenue classification — the one write insight owns.
//
// A module that sells something billing cannot recognise (a program fee, a
// membership sold at the desk) calls tagRevenueSource once it has the invoice
// or payment, so insight credits the right revenue account. Import only this
// file. Re-tagging replaces the previous classification; it never duplicates.

import { DomainError, type TenantContext, type Uuid } from '@bygelo/roundrobin-kernel'
import type { SourceCode } from './csv.ts'

export type RevenueTag = {
  insight_revenue_tag_id: Uuid
  invoice_id: Uuid | null
  payment_id: Uuid | null
  source_code: SourceCode
}

export type RevenueTagInput =
  | { invoice_id: Uuid; source_code: SourceCode }
  | { payment_id: Uuid; source_code: SourceCode }
  | { invoice_code: string; source_code: SourceCode }
  | { payment_code: string; source_code: SourceCode }

export async function tagRevenueSource(tenant: TenantContext, input: RevenueTagInput): Promise<RevenueTag> {
  const q = tenant.query
  const org = tenant.organization_id

  if ('invoice_id' in input || 'invoice_code' in input) {
    const [invoice] =
      'invoice_id' in input
        ? await q<{ invoice_id: Uuid }[]>`SELECT invoice_id FROM invoice WHERE organization_id = ${org}::uuid AND invoice_id = ${input.invoice_id}::uuid AND deleted_at IS NULL`
        : await q<{ invoice_id: Uuid }[]>`SELECT invoice_id FROM invoice WHERE organization_id = ${org}::uuid AND invoice_code = ${input.invoice_code} AND deleted_at IS NULL`
    if (!invoice) throw new DomainError('no invoice with that code in this venue', 404)
    const [row] = await q<RevenueTag[]>`
      INSERT INTO insight_revenue_tag (organization_id, invoice_id, source_code)
      VALUES (${org}::uuid, ${invoice.invoice_id}::uuid, ${input.source_code})
      ON CONFLICT (organization_id, invoice_id)
      DO UPDATE SET source_code = EXCLUDED.source_code, deleted_at = NULL
      RETURNING insight_revenue_tag_id, invoice_id, payment_id, source_code`
    return row!
  }

  const [payment] =
    'payment_id' in input
      ? await q<{ payment_id: Uuid }[]>`SELECT payment_id FROM payment WHERE organization_id = ${org}::uuid AND payment_id = ${input.payment_id}::uuid`
      : await q<{ payment_id: Uuid }[]>`SELECT payment_id FROM payment WHERE organization_id = ${org}::uuid AND payment_code = ${input.payment_code}`
  if (!payment) throw new DomainError('no payment with that code in this venue', 404)
  const [row] = await q<RevenueTag[]>`
    INSERT INTO insight_revenue_tag (organization_id, payment_id, source_code)
    VALUES (${org}::uuid, ${payment.payment_id}::uuid, ${input.source_code})
    ON CONFLICT (organization_id, payment_id)
    DO UPDATE SET source_code = EXCLUDED.source_code, deleted_at = NULL
    RETURNING insight_revenue_tag_id, invoice_id, payment_id, source_code`
  return row!
}
