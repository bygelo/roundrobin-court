// Operator → Insight. Owner figures for a date range, and the files an
// accountant imports. roundrobin reports and exports; it does not keep books.

import { ChartBar, DownloadSimple, FileCsv, Receipt } from '@phosphor-icons/react'
import { useId, useState } from 'react'
import { operatorFetch } from '../../api.ts'
import { Alert, Badge, Button, Card, EmptyState, ErrorAlert, PageHeader, ResourceView, Stat, Tabs, TextInput } from '../../component/ui.tsx'
import { DEFAULT_TIME_ZONE, formatDate, formatMoney, toDateInput } from '../../format.ts'
import { useAction, useResource } from '../../hook.ts'
import type { PageProp } from '../../registry.ts'
import './insight.css'

type Rate = string | null

type Summary = {
  range: { from: string; to: string; day_count: number; time_zone: string }
  is_empty: boolean
  occupancy: {
    sellable_hour: string
    booked_hour: string
    occupancy_rate: Rate
    court: { resource_id: string; display_name: string; sellable_hour: string; booked_hour: string; occupancy_rate: Rate }[]
  }
  revenue: {
    currency_code: string
    gross_amount: string
    refund_amount: string
    net_amount: string
    source: { source_code: string; display_name: string; account_code: string; gross_amount: string; refund_amount: string; net_amount: string; share_rate: Rate }[]
  }
  booking: {
    booking_count: number
    confirmed_count: number
    cancelled_count: number
    cancellation_rate: Rate
    no_show: { is_available: boolean; eligible_count: number; no_show_count: number; no_show_rate: Rate; reason: string | null }
  }
  player: { player_count: number; repeat_player_count: number; new_player_count: number }
  open_play: { is_available: boolean; session_count: number; seat_count: number; filled_count: number; fill_rate: Rate }
  inventory_alert: { variant_id: string; product_name: string; variant_name: string; sku: string | null; quantity_on_hand: number; threshold_count: number }[]
  health: { notification_failed_count: number; connector_dead_letter_count: number }
  generated_at: string
}

type Daily = {
  day: { entry_date: string; booking_count: number; court_hour: string; sellable_hour: string; occupancy_rate: Rate; revenue_amount: string }[]
}

type AccountMap = {
  account: { account_code: string; account_name: string; account_kind: string; rule: string }[]
}

type Preset = 'today' | 'week' | 'month_30' | 'this_month' | 'custom'

const PRESET: { value: Exclude<Preset, 'custom'>; label: string }[] = [
  { value: 'today', label: 'Today' },
  { value: 'week', label: 'Last 7 days' },
  { value: 'month_30', label: 'Last 30 days' },
  { value: 'this_month', label: 'This month' },
]

function shiftDate(date_key: string, day_count: number): string {
  const [year, month, day] = date_key.split('-').map(Number) as [number, number, number]
  return new Date(Date.UTC(year, month - 1, day + day_count)).toISOString().slice(0, 10)
}

function presetRange(preset: Exclude<Preset, 'custom'>, time_zone: string): { from: string; to: string } {
  const today = toDateInput(new Date(), time_zone)
  if (preset === 'today') return { from: today, to: today }
  if (preset === 'week') return { from: shiftDate(today, -6), to: today }
  if (preset === 'month_30') return { from: shiftDate(today, -29), to: today }
  return { from: `${today.slice(0, 8)}01`, to: today }
}

/** "0.7143" → "71.4%". Display only; the exact ratio stays in the API. */
function percent(rate: Rate, digit = 1): string {
  return rate === null ? '—' : `${(Number(rate) * 100).toFixed(digit)}%`
}

function hour(value: string): string {
  return `${Number(value).toLocaleString('en-PH', { maximumFractionDigits: 2 })} h`
}

/** Midday UTC keeps a calendar date on the same day in every venue time zone. */
function dateLabel(date_key: string, time_zone: string): string {
  return formatDate(`${date_key}T12:00:00Z`, time_zone)
}

async function downloadCsv(path: string, filename: string): Promise<string> {
  const text = await operatorFetch<string>(path)
  const url = URL.createObjectURL(new Blob([typeof text === 'string' ? text : ''], { type: 'text/csv;charset=utf-8' }))
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.append(anchor)
  anchor.click()
  anchor.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 1000)
  return filename
}

export default function Page(_prop: PageProp) {
  const [preset, setPreset] = useState<Preset>('week')
  const [range, setRange] = useState(() => presetRange('week', DEFAULT_TIME_ZONE))
  const [draft, setDraft] = useState(range)
  const [time_zone, setTimeZone] = useState(DEFAULT_TIME_ZONE)
  const [downloaded, setDownloaded] = useState<string>()

  const query = `from=${range.from}&to=${range.to}`
  const summary = useResource(async () => {
    const body = await operatorFetch<Summary>(`/api/v1/insight/summary?${query}`)
    if (body.range.time_zone !== time_zone) setTimeZone(body.range.time_zone)
    return body
  }, [query])
  const daily = useResource(() => operatorFetch<Daily>(`/api/v1/insight/daily?${query}`), [query])
  const account = useResource(() => operatorFetch<AccountMap>('/api/v1/insight/account'), [])

  const download = useAction(async (path: string, filename: string) => {
    setDownloaded(undefined)
    const name = await downloadCsv(path, filename)
    setDownloaded(name)
    return name
  })

  function choosePreset(value: Exclude<Preset, 'custom'>) {
    const next = presetRange(value, time_zone)
    setPreset(value)
    setRange(next)
    setDraft(next)
  }

  const is_draft_valid = draft.from !== '' && draft.to !== '' && draft.to >= draft.from
  const range_label = range.from === range.to ? dateLabel(range.from, time_zone) : `${dateLabel(range.from, time_zone)} – ${dateLabel(range.to, time_zone)}`
  const file_range = range.from === range.to ? range.from : `${range.from}-to-${range.to}`

  return (
    <>
      <PageHeader
        eyebrow="Business"
        title="Insight"
        description="How your courts, programs, and shop performed, from your own bookings and payments — plus the files your accountant imports."
      />

      <section className="insight-range" aria-label="Date range">
        <div className="insight-preset" role="group" aria-label="Quick ranges">
          {PRESET.map((one) => (
            <Button
              key={one.value}
              tone="secondary"
              size="sm"
              aria-pressed={preset === one.value}
              onClick={() => choosePreset(one.value)}
            >
              {one.label}
            </Button>
          ))}
        </div>
        <form
          className="insight-custom"
          onSubmit={(event) => {
            event.preventDefault()
            if (!is_draft_valid) return
            setPreset('custom')
            setRange(draft)
          }}
        >
          <TextInput label="From" type="date" value={draft.from} max={draft.to || undefined} required onChange={(event) => setDraft({ ...draft, from: event.target.value })} />
          <TextInput
            label="To"
            type="date"
            value={draft.to}
            min={draft.from || undefined}
            required
            error={draft.from && draft.to && draft.to < draft.from ? 'Pick a date on or after From' : undefined}
            onChange={(event) => setDraft({ ...draft, to: event.target.value })}
          />
          <Button type="submit" tone="primary" disabled={!is_draft_valid}>
            Show range
          </Button>
        </form>
        <p className="muted">
          Showing {range_label} · times in {time_zone}
        </p>
      </section>

      <ResourceView resource={summary}>
        {(data) =>
          data.is_empty ? (
            <EmptyState
              title="Nothing happened in this range"
              description="No bookings, sessions, or payments fall between these dates. Try a wider range, or open the court board to take the first booking."
              action={
                <Button tone="secondary" onClick={() => choosePreset('month_30')}>
                  Show last 30 days
                </Button>
              }
            />
          ) : (
            <div className="stack--lg">
              <KpiRow data={data} />
              <div className="grid--2">
                <RevenueCard data={data} />
                <OccupancyCard data={data} />
              </div>
              <TrendCard daily={daily} time_zone={time_zone} />
              <AlertCard data={data} />
            </div>
          )
        }
      </ResourceView>

      <div className="stack--lg" style={{ marginTop: 'var(--space-6)' }}>
        <Card
          title="Downloads"
          description="Import the journal into your accounting software; roundrobin does not keep your books."
        >
          <div className="stack">
            <div className="insight-download">
              <Button
                tone="primary"
                icon={<Receipt size={18} aria-hidden />}
                disabled={download.is_pending}
                onClick={() => void download.run(`/api/v1/insight/journal.csv?${query}`, `journal-${file_range}.csv`)}
              >
                Accountant journal CSV
              </Button>
              <Button
                tone="secondary"
                icon={<FileCsv size={18} aria-hidden />}
                disabled={download.is_pending}
                onClick={() => void download.run(`/api/v1/insight/export.csv?${query}&kind=booking`, `insight-booking-${file_range}.csv`)}
              >
                Bookings CSV
              </Button>
              <Button
                tone="secondary"
                icon={<DownloadSimple size={18} aria-hidden />}
                disabled={download.is_pending}
                onClick={() => void download.run(`/api/v1/insight/export.csv?${query}&kind=revenue`, `insight-revenue-${file_range}.csv`)}
              >
                Revenue CSV
              </Button>
              <Button
                tone="quiet"
                icon={<ChartBar size={18} aria-hidden />}
                disabled={download.is_pending}
                onClick={() => void download.run(`/api/v1/insight/export.csv?${query}&kind=occupancy`, `insight-occupancy-${file_range}.csv`)}
              >
                Occupancy CSV
              </Button>
            </div>
            <ErrorAlert error={download.error} onDismiss={download.clearError} />
            {downloaded && (
              <Alert severity="success" title="Download ready" onDismiss={() => setDownloaded(undefined)}>
                {downloaded} for {range_label} was saved to your downloads.
              </Alert>
            )}
            <p className="muted">
              Each journal entry balances: money received debits the cash or clearing account it was paid into and credits the revenue
              account for what was sold; a refund debits Refunds and credits the account the money went back out of. Revenue is counted
              when a payment is posted, not when a booking is made.
            </p>
            <details className="insight-account">
              <summary>Which accounts the journal uses</summary>
              <ResourceView resource={account}>
                {(map) => (
                  <div className="table-wrap" tabIndex={0}>
                    <table className="table">
                      <thead>
                        <tr>
                          <th scope="col">Code</th>
                          <th scope="col">Account</th>
                          <th scope="col">Used for</th>
                        </tr>
                      </thead>
                      <tbody>
                        {map.account.map((one) => (
                          <tr key={one.account_code}>
                            <td className="mono">{one.account_code}</td>
                            <td>{one.account_name}</td>
                            <td className="muted">{one.rule}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </ResourceView>
            </details>
          </div>
        </Card>
      </div>
    </>
  )
}

function KpiRow({ data }: { data: Summary }) {
  return (
    <section className="insight-kpi" aria-label="Key figures">
      <Stat label="Occupancy" value={percent(data.occupancy.occupancy_rate)} hint={`${hour(data.occupancy.booked_hour)} of ${hour(data.occupancy.sellable_hour)} booked`} />
      <Stat label="Net revenue" value={formatMoney(data.revenue.net_amount)} hint={data.revenue.refund_amount === '0.00' ? 'No refunds' : `after ${formatMoney(data.revenue.refund_amount)} refunded`} />
      <Stat label="Bookings" value={data.booking.confirmed_count.toLocaleString('en-PH')} hint={`${data.booking.cancelled_count} cancelled`} />
      <Stat label="Cancellation rate" value={percent(data.booking.cancellation_rate)} hint={`${data.booking.cancelled_count} of ${data.booking.booking_count}`} />
      <Stat
        label="No-show rate"
        value={data.booking.no_show.is_available ? percent(data.booking.no_show.no_show_rate) : 'Not available'}
        hint={data.booking.no_show.is_available ? `${data.booking.no_show.no_show_count} of ${data.booking.no_show.eligible_count} past bookings` : (data.booking.no_show.reason ?? undefined)}
      />
      <Stat label="Repeat players" value={data.player.repeat_player_count.toLocaleString('en-PH')} hint={`${data.player.new_player_count} new · ${data.player.player_count} played`} />
      <Stat
        label="Open-play fill"
        value={data.open_play.is_available ? percent(data.open_play.fill_rate) : 'Not available'}
        hint={data.open_play.is_available ? (data.open_play.seat_count > 0 ? `${data.open_play.filled_count} of ${data.open_play.seat_count} spots` : 'No open play in range') : 'Open play is not set up'}
      />
    </section>
  )
}

function RevenueCard({ data }: { data: Summary }) {
  return (
    <Card title="Revenue by source" description="Payments received, less refunds, in this range.">
      <div className="table-wrap" tabIndex={0}>
        <table className="table">
          <thead>
            <tr>
              <th scope="col">Source</th>
              <th scope="col" className="number">Received</th>
              <th scope="col" className="number">Refunded</th>
              <th scope="col" className="number">Net</th>
              <th scope="col">Share</th>
            </tr>
          </thead>
          <tbody>
            {data.revenue.source.map((one) => {
              const share = one.share_rate === null ? 0 : Math.max(0, Math.min(1, Number(one.share_rate)))
              return (
                <tr key={one.source_code}>
                  <th scope="row" style={{ fontWeight: 600, textAlign: 'left' }}>{one.display_name}</th>
                  <td className="number">{formatMoney(one.gross_amount)}</td>
                  <td className="number">{one.refund_amount === '0.00' ? '—' : formatMoney(one.refund_amount)}</td>
                  <td className="number">{formatMoney(one.net_amount)}</td>
                  <td>
                    <div className="insight-share">
                      <div className="insight-share__track" aria-hidden>
                        <div className="insight-share__fill" style={{ width: `${share * 100}%` }} />
                      </div>
                      <span className="insight-share__label">{percent(one.share_rate, 0)}</span>
                    </div>
                  </td>
                </tr>
              )
            })}
          </tbody>
          <tfoot>
            <tr>
              <td>Total</td>
              <td className="number">{formatMoney(data.revenue.gross_amount)}</td>
              <td className="number">{data.revenue.refund_amount === '0.00' ? '—' : formatMoney(data.revenue.refund_amount)}</td>
              <td className="number">{formatMoney(data.revenue.net_amount)}</td>
              <td />
            </tr>
          </tfoot>
        </table>
      </div>
    </Card>
  )
}

function OccupancyCard({ data }: { data: Summary }) {
  const court = data.occupancy.court.filter((one) => one.sellable_hour !== '0.00' || one.booked_hour !== '0.00')
  return (
    <Card title="Occupancy by court" description="Booked hours out of the hours each court was open for booking.">
      {court.length === 0 ? (
        <EmptyState title="No bookable hours in this range" description="Add sessions to your courts in Venue setup so there is time to book." />
      ) : (
        <ul className="insight-court">
          {court.map((one) => {
            const share = one.occupancy_rate === null ? 0 : Math.max(0, Math.min(1, Number(one.occupancy_rate)))
            return (
              <li key={one.resource_id} className="insight-court__row">
                <div className="insight-court__head">
                  <span className="insight-court__name">{one.display_name}</span>
                  <span className="insight-court__figure">
                    {hour(one.booked_hour)} of {hour(one.sellable_hour)} · {percent(one.occupancy_rate)}
                  </span>
                </div>
                <div className="insight-court__track" aria-hidden>
                  <div className="insight-court__fill" style={{ width: `${share * 100}%` }} />
                </div>
              </li>
            )
          })}
        </ul>
      )}
    </Card>
  )
}

type Metric = 'revenue' | 'court_hour' | 'booking'

const METRIC: { value: Metric; label: string }[] = [
  { value: 'revenue', label: 'Net revenue' },
  { value: 'court_hour', label: 'Court-hours' },
  { value: 'booking', label: 'Bookings' },
]

function metricValue(day: Daily['day'][number], metric: Metric): number {
  if (metric === 'revenue') return Number(day.revenue_amount)
  if (metric === 'court_hour') return Number(day.court_hour)
  return day.booking_count
}

function metricText(day: Daily['day'][number], metric: Metric): string {
  if (metric === 'revenue') return formatMoney(day.revenue_amount)
  if (metric === 'court_hour') return hour(day.court_hour)
  return `${day.booking_count} booking${day.booking_count === 1 ? '' : 's'}`
}

function TrendCard({ daily, time_zone }: { daily: ReturnType<typeof useResource<Daily>>; time_zone: string }) {
  const [metric, setMetric] = useState<Metric>('revenue')
  const title_id = useId()
  const desc_id = useId()

  return (
    <Card title="Daily trend">
      <ResourceView resource={daily}>
        {(data) => {
          const day = data.day
          const value = day.map((one) => metricValue(one, metric))
          const max = Math.max(0, ...value)
          const min = Math.min(0, ...value)
          const span = max - min || 1
          const width = 640
          const height = 220
          const top = 12
          const bottom = 28
          const plot = height - top - bottom
          const zero_y = top + (max / span) * plot
          const slot = width / Math.max(day.length, 1)
          const bar_width = Math.max(2, Math.min(40, slot * 0.7))
          const label_every = Math.ceil(day.length / 8)
          const label = METRIC.find((one) => one.value === metric)!.label
          const peak = day.reduce<Daily['day'][number] | undefined>((best, one) => (best === undefined || metricValue(one, metric) > metricValue(best, metric) ? one : best), undefined)

          return (
            <div className="insight-chart">
              <Tabs label="Chart measure" value={metric} option={METRIC} onChange={setMetric} />
              <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-labelledby={`${title_id} ${desc_id}`}>
                <title id={title_id}>{`${label} per day`}</title>
                <desc id={desc_id}>
                  {peak
                    ? `${day.length} days. Highest: ${dateLabel(peak.entry_date, time_zone)} with ${metricText(peak, metric)}. The table below lists every day.`
                    : 'No days in range.'}
                </desc>
                <line className="insight-chart__axis" x1={0} x2={width} y1={zero_y} y2={zero_y} />
                {day.map((one, index) => {
                  const amount = value[index]!
                  const bar_height = (Math.abs(amount) / span) * plot
                  const x = index * slot + (slot - bar_width) / 2
                  const y = amount >= 0 ? zero_y - bar_height : zero_y
                  return (
                    <g key={one.entry_date}>
                      <rect
                        className={amount < 0 ? 'insight-chart__bar insight-chart__bar--negative' : 'insight-chart__bar'}
                        x={x}
                        y={y}
                        width={bar_width}
                        height={Math.max(bar_height, amount === 0 ? 0 : 1)}
                        rx={2}
                      />
                      {index % label_every === 0 && (
                        <text className="insight-chart__label" x={index * slot + slot / 2} y={height - 8} textAnchor="middle">
                          {one.entry_date.slice(5)}
                        </text>
                      )}
                    </g>
                  )
                })}
              </svg>
              <table className="visually-hidden">
                <caption>{`${label} per day`}</caption>
                <thead>
                  <tr>
                    <th scope="col">Date</th>
                    <th scope="col">Bookings</th>
                    <th scope="col">Court-hours</th>
                    <th scope="col">Net revenue</th>
                  </tr>
                </thead>
                <tbody>
                  {day.map((one) => (
                    <tr key={one.entry_date}>
                      <th scope="row">{dateLabel(one.entry_date, time_zone)}</th>
                      <td>{one.booking_count}</td>
                      <td>{hour(one.court_hour)}</td>
                      <td>{formatMoney(one.revenue_amount)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )
        }}
      </ResourceView>
    </Card>
  )
}

function AlertCard({ data }: { data: Summary }) {
  const low_stock = data.inventory_alert
  const is_clear = low_stock.length === 0 && data.health.notification_failed_count === 0 && data.health.connector_dead_letter_count === 0
  return (
    <Card title="Alerts" description="Things that need a person, not a report.">
      {is_clear ? (
        <p className="row">
          <Badge tone="success">All clear</Badge>
          <span className="muted">Stock is above reorder levels and every message and connector event went through.</span>
        </p>
      ) : (
        <ul className="insight-alert">
          <li className="insight-alert__row">
            <span>Low stock</span>
            <Badge tone={low_stock.length > 0 ? 'caution' : 'success'}>{low_stock.length} item{low_stock.length === 1 ? '' : 's'}</Badge>
          </li>
          {low_stock.map((one) => (
            <li key={one.variant_id} className="insight-alert__row">
              <span className="muted">
                {one.product_name} · {one.variant_name}
                {one.sku ? ` (${one.sku})` : ''}
              </span>
              <Badge tone={one.quantity_on_hand === 0 ? 'danger' : 'caution'}>
                {one.quantity_on_hand === 0 ? 'Out of stock' : `${one.quantity_on_hand} left · reorder at ${one.threshold_count}`}
              </Badge>
            </li>
          ))}
          <li className="insight-alert__row">
            <span>Player messages that failed to send</span>
            <Badge tone={data.health.notification_failed_count > 0 ? 'danger' : 'success'}>{data.health.notification_failed_count}</Badge>
          </li>
          <li className="insight-alert__row">
            <span>Connector events stuck after retries</span>
            <Badge tone={data.health.connector_dead_letter_count > 0 ? 'danger' : 'success'}>{data.health.connector_dead_letter_count}</Badge>
          </li>
        </ul>
      )}
    </Card>
  )
}
