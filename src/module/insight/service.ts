// Insight — every figure is read from the records that own it, inside the
// tenant transaction, and computed in SQL numeric. Nothing here is stored.
//
// Definitions (the benchmark checks these by hand, so they are stated once):
//
//   Window        from 00:00 on `from` to 24:00 on `to`, in the venue time zone
//                 (first site's time_zone, else the organization's, else Asia/Manila).
//   Occupancy     booked court-hours ÷ sellable court-hours.
//                 sellable = union of session windows claimed by a court
//                 (session_resource), excluding open_play and class sessions,
//                 minus closures, clipped to the window.
//                 booked   = confirmed bookings on that court, clipped to sellable.
//   Cancellation  cancelled ÷ (confirmed + cancelled) bookings starting in the window.
//   No-show       confirmed bookings in the window that have ended with no
//                 arrival check-in ÷ confirmed bookings that have ended. Only
//                 available once the venue uses check-in for bookings.
//   Players       repeat = parties with ≥ 2 confirmed bookings in the window;
//                 new    = parties with a confirmed booking in the window and none before it.
//   Revenue       cash basis. + posted billing payments (by posted_at)
//                 − refunds (by created_at)
//                 + shop orders with no billing payment (by placed_at)
//                 − those orders once cancelled.
//                 Source of a payment: its insight_revenue_tag, else shop_sale → shop,
//                 else portal_payment → court booking; otherwise split by the invoices
//                 it cleared (invoice tag, else portal_booking → court booking), with
//                 any remainder → other. A refund follows shop_refund, else its
//                 payment's source, else the invoices it re-opened, else the payment's
//                 largest source. Orders placed on channel 'invoice' are left to billing.

import type { TenantContext, Uuid } from '@bygelo/roundrobin-kernel'
import { summarizePlayFill } from '../play/contract.ts'
import { JOURNAL_ACCOUNT, REVENUE_SOURCE, accountName, journalMemo, sourceName, toCsv, type SourceCode } from './csv.ts'
import { DEFAULT_TIME_ZONE, isTimeZone, localDateKey, rateText, resolveRangeInput } from './range.ts'

type Query = TenantContext['query']

export type InsightWindow = {
  from: string
  to: string
  day_count: number
  time_zone: string
  starts_at: Date
  ends_at: Date
}

/** Court tables owned by other lanes. A dashboard degrades when one is absent; it never fails. */
export type Presence = {
  portal_booking: boolean
  portal_payment: boolean
  shop_sale: boolean
  shop_refund: boolean
  shop_product: boolean
  arrival_check_in: boolean
}

export async function readPresence(tenant: TenantContext): Promise<Presence> {
  const [row] = await tenant.query<Presence[]>`
    SELECT to_regclass('portal_booking') IS NOT NULL AS portal_booking,
           to_regclass('portal_payment') IS NOT NULL AS portal_payment,
           to_regclass('shop_sale') IS NOT NULL AS shop_sale,
           to_regclass('shop_refund') IS NOT NULL AS shop_refund,
           to_regclass('shop_product') IS NOT NULL AS shop_product,
           to_regclass('arrival_check_in') IS NOT NULL AS arrival_check_in`
  return row!
}

export async function resolveWindow(
  tenant: TenantContext,
  input: { from?: string | undefined; to?: string | undefined },
): Promise<InsightWindow> {
  const [zone] = await tenant.query<{ site_time_zone: string | null; organization_time_zone: string | null }[]>`
    SELECT (SELECT s.time_zone FROM site s
             WHERE s.organization_id = ${tenant.organization_id}::uuid AND s.deleted_at IS NULL AND s.time_zone IS NOT NULL
             ORDER BY s.created_at, s.site_code LIMIT 1) AS site_time_zone,
           (SELECT o.time_zone FROM organization o WHERE o.organization_id = ${tenant.organization_id}::uuid) AS organization_time_zone`
  const time_zone = [zone?.site_time_zone, zone?.organization_time_zone].find(isTimeZone) ?? DEFAULT_TIME_ZONE
  const range = resolveRangeInput(input, localDateKey(new Date(), time_zone))
  const [bound] = await tenant.query<{ starts_at: Date; ends_at: Date }[]>`
    SELECT (${range.from}::date::timestamp AT TIME ZONE ${time_zone}::text) AS starts_at,
           ((${range.to}::date + 1)::timestamp AT TIME ZONE ${time_zone}::text) AS ends_at`
  return { ...range, time_zone, starts_at: new Date(bound!.starts_at), ends_at: new Date(bound!.ends_at) }
}

// ---------------------------------------------------------------------------
// money — one CTE chain every revenue figure and both exports read from
// ---------------------------------------------------------------------------

/**
 * Yields CTEs ending in `money`: one row per (entry, source) with a positive
 * amount and sign +1 (money in) or −1 (money back).
 */
function moneyCte(q: Query, organization_id: Uuid, has: Presence, window: InsightWindow) {
  const org = q`${organization_id}::uuid`
  const starts = window.starts_at
  const ends = window.ends_at
  const none = q`NULL::text`

  const portal_invoice = has.portal_booking
    ? q`(SELECT 'court_booking'::text FROM portal_booking pb WHERE pb.organization_id = i.organization_id AND pb.invoice_id = i.invoice_id LIMIT 1)`
    : none
  const shop_payment = has.shop_sale
    ? q`(SELECT 'shop'::text FROM shop_sale ss WHERE ss.organization_id = p.organization_id AND ss.payment_id = p.payment_id LIMIT 1)`
    : none
  const portal_payment = has.portal_payment
    ? q`(SELECT 'court_booking'::text FROM portal_payment pp WHERE pp.organization_id = p.organization_id AND pp.payment_id = p.payment_id LIMIT 1)`
    : none
  const shop_method = has.shop_sale
    ? q`(SELECT ss.payment_method_code FROM shop_sale ss WHERE ss.organization_id = p.organization_id AND ss.payment_id = p.payment_id LIMIT 1)`
    : none
  const portal_method = has.portal_payment
    ? q`(SELECT pp.method_code FROM portal_payment pp WHERE pp.organization_id = p.organization_id AND pp.payment_id = p.payment_id LIMIT 1)`
    : none
  const shop_refund = has.shop_refund
    ? q`(SELECT 'shop'::text FROM shop_refund sr WHERE sr.organization_id = r.organization_id AND sr.refund_id = r.refund_id LIMIT 1)`
    : none
  const order_has_sale = has.shop_sale
    ? q`AND NOT EXISTS (SELECT 1 FROM shop_sale ss WHERE ss.organization_id = so.organization_id AND ss.sales_order_id = so.sales_order_id)`
    : q`AND true`

  return q`
    invoice_source AS (
      SELECT i.invoice_id,
             coalesce(
               (SELECT t.source_code FROM insight_revenue_tag t
                 WHERE t.organization_id = i.organization_id AND t.invoice_id = i.invoice_id AND t.deleted_at IS NULL),
               ${portal_invoice}
             ) AS source_code
      FROM invoice i
      WHERE i.organization_id = ${org} AND i.deleted_at IS NULL
    ),
    pay AS (
      SELECT p.payment_id, p.payment_code, p.amount, p.posted_at, p.party_id,
             coalesce(
               (SELECT t.source_code FROM insight_revenue_tag t
                 WHERE t.organization_id = p.organization_id AND t.payment_id = p.payment_id AND t.deleted_at IS NULL),
               ${shop_payment},
               ${portal_payment}
             ) AS fixed_source,
             CASE lower(coalesce(${shop_method}, ${portal_method}, p.method_code, ''))
               WHEN 'cash' THEN '1000'
               WHEN 'gcash' THEN '1010' WHEN 'maya' THEN '1010' WHEN 'paymaya' THEN '1010'
               WHEN 'card' THEN '1020' WHEN 'card_terminal' THEN '1020'
               WHEN 'online' THEN '1030'
               WHEN 'bank' THEN '1040' WHEN 'bank_transfer' THEN '1040'
               ELSE CASE p.collection_mode::text
                 WHEN 'cash_pos' THEN '1000'
                 WHEN 'processor_auto' THEN '1030'
                 ELSE '1040'
               END
             END AS cash_account_code
      FROM payment p
      WHERE p.organization_id = ${org}
        AND p.status IN ('posted', 'refunded')
        AND p.posted_at IS NOT NULL
        AND p.posted_at < ${ends}
    ),
    allocated AS (
      SELECT pa.payment_id, s.source_code, sum(pa.amount) AS amount
      FROM payment_allocation pa
      JOIN invoice_source s ON s.invoice_id = pa.invoice_id AND s.source_code IS NOT NULL
      WHERE pa.organization_id = ${org}
      GROUP BY pa.payment_id, s.source_code
    ),
    pay_split AS (
      SELECT pay.payment_id, pay.fixed_source AS source_code, pay.amount
      FROM pay WHERE pay.fixed_source IS NOT NULL
      UNION ALL
      SELECT a.payment_id, a.source_code, a.amount
      FROM allocated a JOIN pay ON pay.payment_id = a.payment_id AND pay.fixed_source IS NULL
      UNION ALL
      SELECT pay.payment_id, 'other'::text,
             greatest(pay.amount - coalesce((SELECT sum(a.amount) FROM allocated a WHERE a.payment_id = pay.payment_id), 0), 0)
      FROM pay WHERE pay.fixed_source IS NULL
    ),
    refund_row AS (
      SELECT r.refund_id, r.refund_code, r.amount, r.created_at, r.payment_id,
             pay.payment_code, pay.party_id, pay.cash_account_code,
             coalesce(${shop_refund}, pay.fixed_source) AS fixed_source
      FROM refund r
      JOIN pay ON pay.payment_id = r.payment_id
      WHERE r.organization_id = ${org} AND r.created_at >= ${starts} AND r.created_at < ${ends}
    ),
    refund_allocated AS (
      SELECT ra.refund_id, s.source_code, sum(ra.amount) AS amount
      FROM refund_allocation ra
      JOIN refund_row rr ON rr.refund_id = ra.refund_id AND rr.fixed_source IS NULL
      JOIN invoice_source s ON s.invoice_id = ra.invoice_id AND s.source_code IS NOT NULL
      GROUP BY ra.refund_id, s.source_code
    ),
    refund_split AS (
      SELECT rr.refund_id, rr.fixed_source AS source_code, rr.amount
      FROM refund_row rr WHERE rr.fixed_source IS NOT NULL
      UNION ALL
      SELECT ra.refund_id, ra.source_code, ra.amount FROM refund_allocated ra
      UNION ALL
      SELECT rr.refund_id,
             coalesce((SELECT ps.source_code FROM pay_split ps
                        WHERE ps.payment_id = rr.payment_id AND ps.amount > 0
                        ORDER BY ps.amount DESC, ps.source_code LIMIT 1), 'other'),
             greatest(rr.amount - coalesce((SELECT sum(ra.amount) FROM refund_allocated ra WHERE ra.refund_id = rr.refund_id), 0), 0)
      FROM refund_row rr WHERE rr.fixed_source IS NULL
    ),
    order_row AS (
      SELECT so.sales_order_id, so.order_code, so.total_amount, so.placed_at, so.buyer_party_id AS party_id,
             CASE WHEN so.status = 'cancelled' THEN coalesce(
               (SELECT max(m.occurred_at) FROM inventory_movement m
                 WHERE m.organization_id = so.organization_id AND m.sales_order_id = so.sales_order_id
                   AND m.reason IN ('refund', 'cancel')),
               so.updated_at) END AS cancelled_at
      FROM sales_order so
      WHERE so.organization_id = ${org}
        AND so.deleted_at IS NULL
        AND so.status <> 'draft'
        AND so.channel <> 'invoice'
        AND so.total_amount > 0
        ${order_has_sale}
    ),
    money_line AS (
      SELECT 'payment'::text AS event_kind, pay.payment_code AS entry_number, pay.payment_code AS reference,
             pay.posted_at AS occurred_at, pay.party_id, pay.cash_account_code, ps.source_code, ps.amount, 1 AS sign
      FROM pay JOIN pay_split ps ON ps.payment_id = pay.payment_id
      WHERE pay.posted_at >= ${starts} AND ps.amount > 0
      UNION ALL
      SELECT 'refund'::text, rr.refund_code, rr.payment_code, rr.created_at, rr.party_id, rr.cash_account_code,
             rs.source_code, rs.amount, -1
      FROM refund_row rr JOIN refund_split rs ON rs.refund_id = rr.refund_id
      WHERE rs.amount > 0
      UNION ALL
      SELECT 'order'::text, o.order_code, o.order_code, o.placed_at, o.party_id, '1090', 'shop', o.total_amount, 1
      FROM order_row o WHERE o.placed_at >= ${starts} AND o.placed_at < ${ends}
      UNION ALL
      SELECT 'order_cancel'::text, o.order_code || '-cancel', o.order_code, o.cancelled_at, o.party_id, '1090', 'shop', o.total_amount, -1
      FROM order_row o WHERE o.cancelled_at >= ${starts} AND o.cancelled_at < ${ends}
    ),
    money AS (
      SELECT m.event_kind, m.entry_number, m.reference, m.occurred_at, m.cash_account_code, m.source_code,
             m.amount, m.sign,
             (m.occurred_at AT TIME ZONE ${window.time_zone}::text)::date AS entry_date,
             pt.display_name AS party_name
      FROM money_line m
      LEFT JOIN party pt ON pt.party_id = m.party_id
    )`
}

export type RevenueSourceRow = {
  source_code: SourceCode
  display_name: string
  account_code: string
  gross_amount: string
  refund_amount: string
  net_amount: string
  share_rate: string | null
}

export type Revenue = {
  currency_code: 'PHP'
  gross_amount: string
  refund_amount: string
  net_amount: string
  source: RevenueSourceRow[]
}

export async function readRevenue(tenant: TenantContext, has: Presence, window: InsightWindow): Promise<Revenue> {
  const q = tenant.query
  const row = await q<
    { source_code: SourceCode; gross_amount: string; refund_amount: string; net_amount: string; share_rate: string | null; total_gross: string; total_refund: string; total_net: string }[]
  >`
    WITH ${moneyCte(q, tenant.organization_id, has, window)},
    per_source AS (
      SELECT source.source_code, source.sort_order,
             coalesce(sum(m.amount) FILTER (WHERE m.sign = 1), 0) AS gross,
             coalesce(sum(m.amount) FILTER (WHERE m.sign = -1), 0) AS refund,
             coalesce(sum(m.sign * m.amount), 0) AS net
      FROM (VALUES ('court_booking', 1), ('program', 2), ('shop', 3), ('membership', 4), ('other', 5))
             AS source(source_code, sort_order)
      LEFT JOIN money m ON m.source_code = source.source_code
      GROUP BY source.source_code, source.sort_order
    ),
    total AS (SELECT sum(gross) AS gross, sum(refund) AS refund, sum(net) AS net FROM per_source)
    SELECT p.source_code,
           p.gross::numeric(14,2)::text AS gross_amount,
           p.refund::numeric(14,2)::text AS refund_amount,
           p.net::numeric(14,2)::text AS net_amount,
           CASE WHEN total.net > 0 THEN round(p.net / total.net, 4)::text END AS share_rate,
           total.gross::numeric(14,2)::text AS total_gross,
           total.refund::numeric(14,2)::text AS total_refund,
           total.net::numeric(14,2)::text AS total_net
    FROM per_source p CROSS JOIN total
    ORDER BY p.sort_order`
  const first = row[0]!
  return {
    currency_code: 'PHP',
    gross_amount: first.total_gross,
    refund_amount: first.total_refund,
    net_amount: first.total_net,
    source: row.map((one) => ({
      source_code: one.source_code,
      display_name: sourceName(one.source_code),
      account_code: REVENUE_SOURCE.find((each) => each.source_code === one.source_code)!.account_code,
      gross_amount: one.gross_amount,
      refund_amount: one.refund_amount,
      net_amount: one.net_amount,
      share_rate: one.share_rate,
    })),
  }
}

export type MoneyLine = {
  entry_date: string
  entry_number: string
  event_kind: string
  reference: string
  source_code: SourceCode
  cash_account_code: string
  party_name: string | null
  amount: string
}

/** Every money movement in the window, signed. Summing amount gives net revenue. */
export async function listMoneyLine(tenant: TenantContext, has: Presence, window: InsightWindow): Promise<MoneyLine[]> {
  const q = tenant.query
  return q<MoneyLine[]>`
    WITH ${moneyCte(q, tenant.organization_id, has, window)}
    SELECT entry_date::text, entry_number, event_kind, reference, source_code, cash_account_code, party_name,
           (sign * amount)::numeric(14,2)::text AS amount
    FROM money
    ORDER BY occurred_at, entry_number, source_code`
}

export type JournalLine = {
  entry_date: string
  entry_number: string
  account_code: string
  account_name: string
  debit_amount: string
  credit_amount: string
  reference: string
  memo: string
}

/**
 * Journal-shaped lines. Each entry balances by construction: the cash side is
 * the sum of the revenue (or refund) side of the same entry.
 *
 *   payment       Dr cash/clearing          Cr revenue account of each source
 *   refund        Dr 4900 Refunds per source Cr the cash/clearing it was paid into
 *   shop order    Dr 1090 Shop Register     Cr 4200 Merchandise Sales
 *   order cancel  Dr 4900 Refunds           Cr 1090 Shop Register
 */
export async function listJournalLine(tenant: TenantContext, has: Presence, window: InsightWindow): Promise<JournalLine[]> {
  const q = tenant.query
  const row = await q<
    { entry_date: string; entry_number: string; event_kind: string; reference: string; party_name: string | null; source_code: string | null; account_code: string; debit_amount: string; credit_amount: string }[]
  >`
    WITH ${moneyCte(q, tenant.organization_id, has, window)},
    journal_line AS (
      SELECT entry_date, occurred_at, event_kind, entry_number, reference, party_name, source_code,
             CASE WHEN sign = -1 THEN '4900'
                  ELSE CASE source_code
                    WHEN 'court_booking' THEN '4000' WHEN 'program' THEN '4100' WHEN 'shop' THEN '4200'
                    WHEN 'membership' THEN '4300' ELSE '4800' END
             END AS account_code,
             CASE WHEN sign = -1 THEN amount ELSE 0 END AS debit,
             CASE WHEN sign = 1 THEN amount ELSE 0 END AS credit,
             2 AS line_order
      FROM money
      UNION ALL
      SELECT entry_date, occurred_at, event_kind, entry_number, reference, party_name, NULL::text,
             cash_account_code,
             CASE WHEN sign = 1 THEN sum(amount) ELSE 0 END,
             CASE WHEN sign = -1 THEN sum(amount) ELSE 0 END,
             1
      FROM money
      GROUP BY entry_date, occurred_at, event_kind, entry_number, reference, party_name, cash_account_code, sign
    )
    SELECT entry_date::text, entry_number, event_kind, reference, party_name, source_code, account_code,
           debit::numeric(14,2)::text AS debit_amount, credit::numeric(14,2)::text AS credit_amount
    FROM journal_line
    ORDER BY occurred_at, entry_number, line_order, account_code, source_code`
  return row.map((one) => ({
    entry_date: one.entry_date,
    entry_number: one.entry_number,
    account_code: one.account_code,
    account_name: accountName(one.account_code),
    debit_amount: one.debit_amount,
    credit_amount: one.credit_amount,
    reference: one.reference,
    memo: journalMemo({ event_kind: one.event_kind, source_code: one.source_code, party_name: one.party_name, reference: one.reference }),
  }))
}

// ---------------------------------------------------------------------------
// occupancy
// ---------------------------------------------------------------------------

export type OccupancyRow = {
  entry_date: string | null
  resource_id: Uuid | null
  display_name: string | null
  sellable_hour: string
  booked_hour: string
  occupancy_rate: string | null
}

/** Per court (and per day when is_per_day), with total rows where resource_id is null. */
export async function readOccupancy(tenant: TenantContext, window: InsightWindow, is_per_day: boolean): Promise<OccupancyRow[]> {
  const q = tenant.query
  const org = q`${tenant.organization_id}::uuid`
  const tz = q`${window.time_zone}::text`
  const slot = is_per_day
    ? q`SELECT d::date AS entry_date,
               tstzrange((d::date)::timestamp AT TIME ZONE ${tz}, (d::date + 1)::timestamp AT TIME ZONE ${tz}, '[)') AS w
        FROM generate_series(${window.from}::date, ${window.to}::date, interval '1 day') AS d`
    : q`SELECT NULL::date AS entry_date, tstzrange(${window.starts_at}::timestamptz, ${window.ends_at}::timestamptz, '[)') AS w`

  return q<OccupancyRow[]>`
    WITH slot AS (${slot}),
    court AS (
      SELECT r.resource_id, r.site_id, r.display_name, r.sort_order, r.resource_code
      FROM resource r JOIN site s ON s.site_id = r.site_id
      WHERE s.organization_id = ${org} AND s.deleted_at IS NULL AND r.deleted_at IS NULL
    ),
    cell AS (
      SELECT slot.entry_date, c.resource_id, c.display_name, c.sort_order, c.resource_code,
             coalesce((SELECT range_agg(tstzrange(se.starts_at, se.ends_at, '[)') * slot.w)
                         FROM session_resource sr JOIN session se ON se.session_id = sr.session_id
                        WHERE sr.resource_id = c.resource_id AND se.organization_id = ${org}
                          AND se.deleted_at IS NULL AND se.session_type NOT IN ('open_play', 'class')
                          AND tstzrange(se.starts_at, se.ends_at, '[)') && slot.w), '{}'::tstzmultirange)
             - coalesce((SELECT range_agg(tstzrange(cl.starts_at, cl.ends_at, '[)') * slot.w)
                           FROM closure cl
                          WHERE cl.organization_id = ${org}
                            AND (cl.resource_id = c.resource_id OR (cl.resource_id IS NULL AND cl.site_id = c.site_id))
                            AND tstzrange(cl.starts_at, cl.ends_at, '[)') && slot.w), '{}'::tstzmultirange) AS sellable,
             coalesce((SELECT range_agg(b.reserved_range * slot.w)
                         FROM booking b
                        WHERE b.resource_id = c.resource_id AND b.organization_id = ${org}
                          AND b.status = 'confirmed' AND b.reserved_range && slot.w), '{}'::tstzmultirange) AS booked
      FROM slot CROSS JOIN court c
    ),
    measured AS (
      SELECT entry_date, resource_id, display_name, sort_order, resource_code,
             (SELECT coalesce(sum(extract(epoch FROM upper(x) - lower(x))), 0) FROM unnest(sellable) AS x) AS sellable_second,
             (SELECT coalesce(sum(extract(epoch FROM upper(x) - lower(x))), 0) FROM unnest(booked * sellable) AS x) AS booked_second
      FROM cell
    ),
    rolled AS (
      SELECT entry_date, resource_id, display_name, sort_order, resource_code,
             sum(sellable_second) AS sellable_second, sum(booked_second) AS booked_second,
             GROUPING(resource_id) AS is_total
      FROM measured
      GROUP BY GROUPING SETS ((entry_date, resource_id, display_name, sort_order, resource_code), (entry_date))
    )
    SELECT entry_date::text, resource_id, display_name,
           round(sellable_second / 3600, 2)::text AS sellable_hour,
           round(booked_second / 3600, 2)::text AS booked_hour,
           CASE WHEN sellable_second > 0 THEN round(booked_second / sellable_second, 4)::text END AS occupancy_rate
    FROM rolled
    ORDER BY entry_date NULLS FIRST, is_total DESC, sort_order, resource_code`
}

// ---------------------------------------------------------------------------
// bookings, players, open play, inventory, health
// ---------------------------------------------------------------------------

async function readBookingStat(tenant: TenantContext, has: Presence, window: InsightWindow) {
  const q = tenant.query
  const org = q`${tenant.organization_id}::uuid`
  const [count] = await q<{ confirmed_count: number; cancelled_count: number; hold_count: number }[]>`
    SELECT count(*) FILTER (WHERE status = 'confirmed')::int AS confirmed_count,
           count(*) FILTER (WHERE status = 'cancelled')::int AS cancelled_count,
           count(*) FILTER (WHERE status = 'hold')::int AS hold_count
    FROM booking
    WHERE organization_id = ${org} AND starts_at >= ${window.starts_at} AND starts_at < ${window.ends_at}`

  let no_show: { is_available: boolean; eligible_count: number; no_show_count: number; no_show_rate: string | null; reason: string | null } = {
    is_available: false,
    eligible_count: 0,
    no_show_count: 0,
    no_show_rate: null,
    reason: 'Arrival check-in is not installed, so no-shows cannot be told apart from arrivals.',
  }
  if (has.arrival_check_in) {
    const [row] = await q<{ is_in_use: boolean; eligible_count: number; no_show_count: number }[]>`
      WITH in_use AS (
        SELECT EXISTS (SELECT 1 FROM arrival_check_in a WHERE a.organization_id = ${org} AND a.subject_kind = 'booking') AS is_in_use
      )
      SELECT in_use.is_in_use,
             count(b.booking_id) FILTER (WHERE b.ends_at < now())::int AS eligible_count,
             count(b.booking_id) FILTER (WHERE b.ends_at < now() AND NOT EXISTS (
               SELECT 1 FROM arrival_check_in a
                WHERE a.organization_id = b.organization_id AND a.subject_kind = 'booking' AND a.subject_id = b.booking_id))::int AS no_show_count
      FROM in_use
      LEFT JOIN booking b ON b.organization_id = ${org} AND b.status = 'confirmed'
                         AND b.starts_at >= ${window.starts_at} AND b.starts_at < ${window.ends_at}
      GROUP BY in_use.is_in_use`
    no_show = row!.is_in_use
      ? { is_available: true, eligible_count: row!.eligible_count, no_show_count: row!.no_show_count, no_show_rate: rateText(row!.no_show_count, row!.eligible_count), reason: null }
      : { ...no_show, reason: 'No booking has been checked in yet, so no-shows cannot be told apart from arrivals.' }
  }

  const [player] = await q<{ player_count: number; repeat_player_count: number; new_player_count: number }[]>`
    WITH in_range AS (
      SELECT party_id, count(*) AS booking_count
      FROM booking
      WHERE organization_id = ${org} AND status = 'confirmed' AND party_id IS NOT NULL
        AND starts_at >= ${window.starts_at} AND starts_at < ${window.ends_at}
      GROUP BY party_id
    )
    SELECT count(*)::int AS player_count,
           count(*) FILTER (WHERE booking_count >= 2)::int AS repeat_player_count,
           count(*) FILTER (WHERE NOT EXISTS (
             SELECT 1 FROM booking b WHERE b.organization_id = ${org} AND b.party_id = in_range.party_id
               AND b.status = 'confirmed' AND b.starts_at < ${window.starts_at}))::int AS new_player_count
    FROM in_range`

  const decided = count!.confirmed_count + count!.cancelled_count
  return {
    booking: {
      booking_count: decided,
      confirmed_count: count!.confirmed_count,
      cancelled_count: count!.cancelled_count,
      hold_count: count!.hold_count,
      cancellation_rate: rateText(count!.cancelled_count, decided),
      no_show,
    },
    player: player!,
  }
}

async function readOpenPlay(tenant: TenantContext, window: InsightWindow) {
  try {
    const fill = await summarizePlayFill(tenant, { from: window.starts_at, to: window.ends_at })
    return { is_available: true, ...fill, fill_rate: rateText(fill.filled_count, fill.seat_count) }
  } catch {
    return { is_available: false, session_count: 0, seat_count: 0, filled_count: 0, fill_rate: null }
  }
}

export type InventoryAlert = {
  variant_id: Uuid
  product_name: string
  variant_name: string
  sku: string | null
  quantity_on_hand: number
  threshold_count: number
}

export async function listInventoryAlert(tenant: TenantContext, has: Presence): Promise<InventoryAlert[]> {
  const q = tenant.query
  const threshold = has.shop_product
    ? q`coalesce((SELECT sp.low_stock_threshold_count FROM shop_product sp
                   WHERE sp.organization_id = c.organization_id AND sp.catalog_id = c.catalog_id AND sp.deleted_at IS NULL),
                 i.reorder_point, 3)`
    : q`coalesce(i.reorder_point, 3)`
  return q<InventoryAlert[]>`
    SELECT variant_id, product_name, variant_name, sku, quantity_on_hand, threshold_count
    FROM (
      SELECT v.variant_id, c.name AS product_name, v.name AS variant_name, v.sku,
             i.quantity_on_hand, (${threshold})::int AS threshold_count
      FROM inventory i
      JOIN variant v ON v.variant_id = i.variant_id AND v.organization_id = i.organization_id AND v.deleted_at IS NULL
      JOIN catalog c ON c.catalog_id = v.catalog_id AND c.organization_id = v.organization_id
                    AND c.deleted_at IS NULL AND c.status = 'active' AND c.is_track_inventory
      WHERE i.organization_id = ${tenant.organization_id}::uuid
    ) AS stock
    WHERE quantity_on_hand <= threshold_count
    ORDER BY quantity_on_hand, product_name, variant_name
    LIMIT 50`
}

async function readHealth(tenant: TenantContext, window: InsightWindow) {
  const [row] = await tenant.query<{ notification_failed_count: number; connector_dead_letter_count: number }[]>`
    SELECT (SELECT count(*) FROM notification_delivery
             WHERE organization_id = ${tenant.organization_id}::uuid AND status = 'failed'
               AND created_at >= ${window.starts_at} AND created_at < ${window.ends_at})::int AS notification_failed_count,
           (SELECT count(*) FROM connector_event
             WHERE organization_id = ${tenant.organization_id}::uuid AND status = 'dead_letter')::int AS connector_dead_letter_count`
  return row!
}

// ---------------------------------------------------------------------------
// the three read shapes the routes serve
// ---------------------------------------------------------------------------

function rangeView(window: InsightWindow) {
  return {
    from: window.from,
    to: window.to,
    day_count: window.day_count,
    time_zone: window.time_zone,
    starts_at: window.starts_at.toISOString(),
    ends_at: window.ends_at.toISOString(),
  }
}

export async function buildSummary(tenant: TenantContext, window: InsightWindow) {
  const has = await readPresence(tenant)
  const occupancy_row = await readOccupancy(tenant, window, false)
  const total = occupancy_row.find((one) => one.resource_id === null)
  const revenue = await readRevenue(tenant, has, window)
  const { booking, player } = await readBookingStat(tenant, has, window)
  const open_play = await readOpenPlay(tenant, window)
  const inventory_alert = await listInventoryAlert(tenant, has)
  const health = await readHealth(tenant, window)

  const has_revenue = revenue.source.some((one) => one.gross_amount !== '0.00' || one.refund_amount !== '0.00')
  const is_empty =
    booking.booking_count === 0 && !has_revenue && (total?.sellable_hour ?? '0.00') === '0.00' && open_play.session_count === 0

  return {
    range: rangeView(window),
    is_empty,
    occupancy: {
      sellable_hour: total?.sellable_hour ?? '0.00',
      booked_hour: total?.booked_hour ?? '0.00',
      occupancy_rate: total?.occupancy_rate ?? null,
      court: occupancy_row
        .filter((one) => one.resource_id !== null)
        .map((one) => ({
          resource_id: one.resource_id!,
          display_name: one.display_name!,
          sellable_hour: one.sellable_hour,
          booked_hour: one.booked_hour,
          occupancy_rate: one.occupancy_rate,
        })),
    },
    revenue,
    booking,
    player,
    open_play,
    inventory_alert,
    health,
    generated_at: new Date().toISOString(),
  }
}

export type InsightSummary = Awaited<ReturnType<typeof buildSummary>>

export async function buildDaily(tenant: TenantContext, window: InsightWindow) {
  const has = await readPresence(tenant)
  const q = tenant.query
  const occupancy = await readOccupancy(tenant, window, true)
  const booking = await q<{ entry_date: string; booking_count: number }[]>`
    SELECT (starts_at AT TIME ZONE ${window.time_zone}::text)::date::text AS entry_date, count(*)::int AS booking_count
    FROM booking
    WHERE organization_id = ${tenant.organization_id}::uuid AND status = 'confirmed'
      AND starts_at >= ${window.starts_at} AND starts_at < ${window.ends_at}
    GROUP BY 1`
  const revenue = await q<{ entry_date: string; revenue_amount: string }[]>`
    WITH ${moneyCte(q, tenant.organization_id, has, window)}
    SELECT entry_date::text, sum(sign * amount)::numeric(14,2)::text AS revenue_amount
    FROM money GROUP BY entry_date`

  const day = occupancy
    .filter((one) => one.resource_id === null && one.entry_date !== null)
    .map((one) => ({
      entry_date: one.entry_date!,
      booking_count: booking.find((each) => each.entry_date === one.entry_date)?.booking_count ?? 0,
      court_hour: one.booked_hour,
      sellable_hour: one.sellable_hour,
      occupancy_rate: one.occupancy_rate,
      revenue_amount: revenue.find((each) => each.entry_date === one.entry_date)?.revenue_amount ?? '0.00',
    }))
  return { range: rangeView(window), day, generated_at: new Date().toISOString() }
}

// ---------------------------------------------------------------------------
// CSV
// ---------------------------------------------------------------------------

export type ExportKind = 'booking' | 'revenue' | 'occupancy'
export const EXPORT_KIND: ExportKind[] = ['booking', 'revenue', 'occupancy']

export async function exportCsv(tenant: TenantContext, window: InsightWindow, kind: ExportKind): Promise<string> {
  const has = await readPresence(tenant)
  const q = tenant.query

  if (kind === 'booking') {
    const checked_in = has.arrival_check_in
      ? q`EXISTS (SELECT 1 FROM arrival_check_in a WHERE a.organization_id = b.organization_id AND a.subject_kind = 'booking' AND a.subject_id = b.booking_id)`
      : q`NULL::boolean`
    const row = await q<
      { booking_code: string; booking_date: string; start_time: string; end_time: string; court_name: string; session_name: string; status: string; player_name: string | null; participant_count: number; price_amount: string; is_checked_in: boolean | null }[]
    >`
      SELECT b.booking_code,
             to_char(b.starts_at AT TIME ZONE ${window.time_zone}::text, 'YYYY-MM-DD') AS booking_date,
             to_char(b.starts_at AT TIME ZONE ${window.time_zone}::text, 'HH24:MI') AS start_time,
             to_char(b.ends_at AT TIME ZONE ${window.time_zone}::text, 'HH24:MI') AS end_time,
             r.display_name AS court_name,
             coalesce(se.display_name, se.session_code) AS session_name,
             b.status::text AS status,
             pt.display_name AS player_name,
             b.participant_count,
             b.price_amount::text AS price_amount,
             ${checked_in} AS is_checked_in
      FROM booking b
      JOIN resource r ON r.resource_id = b.resource_id
      JOIN session se ON se.session_id = b.session_id
      LEFT JOIN party pt ON pt.party_id = b.party_id
      WHERE b.organization_id = ${tenant.organization_id}::uuid
        AND b.starts_at >= ${window.starts_at} AND b.starts_at < ${window.ends_at}
      ORDER BY b.starts_at, r.sort_order, b.booking_code`
    return toCsv(
      ['booking_code', 'booking_date', 'start_time', 'end_time', 'court', 'session', 'status', 'player', 'participant_count', 'price_amount', 'checked_in'],
      row.map((one) => [
        one.booking_code, one.booking_date, one.start_time, one.end_time, one.court_name, one.session_name, one.status,
        one.player_name, one.participant_count, one.price_amount,
        one.is_checked_in === null ? '' : one.is_checked_in ? 'yes' : 'no',
      ]),
      ['participant_count', 'price_amount'],
    )
  }

  if (kind === 'revenue') {
    const line = await listMoneyLine(tenant, has, window)
    return toCsv(
      ['entry_date', 'entry_number', 'kind', 'reference', 'source', 'paid_into', 'party', 'amount'],
      line.map((one) => [
        one.entry_date, one.entry_number, one.event_kind, one.reference, sourceName(one.source_code),
        accountName(one.cash_account_code), one.party_name, one.amount,
      ]),
      ['amount'],
    )
  }

  const row = await readOccupancy(tenant, window, true)
  return toCsv(
    ['date', 'court', 'sellable_hour', 'booked_hour', 'occupancy_percent'],
    row
      .filter((one) => one.entry_date !== null)
      .map((one) => [
        one.entry_date, one.resource_id === null ? 'All courts' : one.display_name, one.sellable_hour, one.booked_hour,
        one.occupancy_rate === null ? '' : percentText(one.occupancy_rate),
      ]),
    ['sellable_hour', 'booked_hour', 'occupancy_percent'],
  )
}

/** "0.7143" → "71.43", by moving the decimal point in the string, not by float math. */
function percentText(rate: string): string {
  const [whole = '0', fraction = ''] = rate.split('.')
  const digit = `${whole}${fraction.padEnd(4, '0')}`.replace(/^0+(?=\d{3})/, '')
  return `${digit.slice(0, -2)}.${digit.slice(-2)}`
}

export async function exportJournalCsv(tenant: TenantContext, window: InsightWindow): Promise<string> {
  const has = await readPresence(tenant)
  const line = await listJournalLine(tenant, has, window)
  return toCsv(
    ['entry_date', 'entry_number', 'account_code', 'account_name', 'debit_amount', 'credit_amount', 'reference', 'memo'],
    line.map((one) => [one.entry_date, one.entry_number, one.account_code, one.account_name, one.debit_amount, one.credit_amount, one.reference, one.memo]),
    ['debit_amount', 'credit_amount'],
  )
}

export { JOURNAL_ACCOUNT }
