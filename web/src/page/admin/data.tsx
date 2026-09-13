// /operator/data — export, import, and player privacy requests (R24).

import { DownloadSimple, UploadSimple } from '@phosphor-icons/react'
import { useState } from 'react'
import { jsonBody, operatorFetch } from '../../api.ts'
import {
  Alert,
  Badge,
  Button,
  Card,
  EmptyState,
  Field,
  PageHeader,
  ResourceView,
  Stat,
  TextArea,
} from '../../component/ui.tsx'
import { formatDate, formatDateTime, titleCase } from '../../format.ts'
import { useAction, useResource } from '../../hook.ts'
import type { PageProp } from '../../registry.ts'
import { useOperator } from '../../session.tsx'
import { ConfirmDialog, downloadJson, errorMessage } from './shared.tsx'

type ExportSummary = {
  version: number
  exported_at: string
  organization: { organization_code: string; display_name: string }
  checksum: string
  table: { table_name: string; record_count: number }[]
  not_included: { label: string; record_count: number }[]
}

type ExportDocument = {
  version?: number
  exported_at?: string
  checksum?: string
  organization?: { display_name?: string }
  count?: Record<string, number>
}

type PrivacyRequest = {
  admin_privacy_request_id: string
  request_kind: 'access' | 'erasure'
  status: 'received' | 'completed' | 'closed'
  booking_code: string
  email_mask: string
  is_verified: boolean
  party_display_name: string | null
  has_bundle: boolean
  resolution_note: string | null
  fulfilled_by_display_name: string | null
  created_at: string
  completed_at: string | null
}

const TABLE_LABEL: Record<string, string> = {
  scope: 'Seasons and scopes',
  party: 'Player profiles',
  actor: 'Staff',
  role: 'Roles',
  role_capability: 'Role permissions',
  actor_role: 'Role assignments',
  organization_module: 'Module settings',
}

const STATUS_TONE = { received: 'info', completed: 'success', closed: 'neutral' } as const

type Notice = { severity: 'success' | 'danger'; title: string; body: string }

export default function Page(_prop: PageProp) {
  const operator = useOperator()
  const can_export = operator.can('kernel.export')
  const can_manage = operator.can('admin.manage')
  const [notice, setNotice] = useState<Notice>()

  return (
    <div className="stack stack--lg">
      <PageHeader
        eyebrow="Admin"
        title="Venue data"
        description="Take your venue's setup with you, bring it into a new venue, and answer players who ask about their data."
      />
      {notice && (
        <Alert severity={notice.severity} title={notice.title} onDismiss={() => setNotice(undefined)}>
          {notice.body}
        </Alert>
      )}
      {can_export ? (
        <div className="grid grid--2">
          <ExportCard onNotice={setNotice} />
          <ImportCard onNotice={setNotice} />
        </div>
      ) : (
        <Alert severity="info" title="Export and import are owner-only">
          Ask an owner to download or import venue data.
        </Alert>
      )}
      <PrivacyCard can_manage={can_manage} onNotice={setNotice} />
    </div>
  )
}

function ExportCard({ onNotice }: { onNotice: (notice: Notice) => void }) {
  const summary = useResource(() => operatorFetch<ExportSummary>('/api/v1/admin/export/summary'), [])
  const download = useAction(async () => {
    const document = await operatorFetch<ExportDocument>('/api/v1/export')
    const code = summary.data?.organization.organization_code ?? 'venue'
    downloadJson(`${code}-configuration-${new Date().toISOString().slice(0, 10)}.json`, document)
    return document
  })

  return (
    <Card
      title="Export"
      description="A versioned JSON file of your venue's setup. It never contains a password, key, or sign-in token."
    >
      <ResourceView resource={summary}>
        {(data) => (
          <div className="stack">
            <div className="admin-count">
              {data.table.map((one) => (
                <Stat key={one.table_name} label={TABLE_LABEL[one.table_name] ?? titleCase(one.table_name)} value={one.record_count} />
              ))}
            </div>
            <dl className="admin-fact">
              <div>
                <dt>Format</dt>
                <dd>Version {data.version}</dd>
              </div>
              <div>
                <dt>Checksum</dt>
                <dd className="mono" title={data.checksum}>
                  {data.checksum.slice(0, 23)}…
                </dd>
              </div>
            </dl>
            <p className="muted">
              Not in this file yet:{' '}
              {data.not_included.map((one) => `${one.label.toLowerCase()} (${one.record_count})`).join(', ')}.
            </p>
            <div>
              <Button
                icon={<DownloadSimple size={18} aria-hidden />}
                disabled={download.is_pending}
                onClick={async () => {
                  const document = await download.run()
                  if (document) {
                    onNotice({ severity: 'success', title: 'Export downloaded', body: `Checksum ${document.checksum ?? ''}` })
                  }
                }}
              >
                {download.is_pending ? 'Preparing…' : 'Download JSON'}
              </Button>
            </div>
            {download.error && <Alert severity="danger">{download.error.message}</Alert>}
          </div>
        )}
      </ResourceView>
    </Card>
  )
}

function ImportCard({ onNotice }: { onNotice: (notice: Notice) => void }) {
  const [document, setDocument] = useState<ExportDocument>()
  const [file_error, setFileError] = useState<string>()
  const [is_confirm, setConfirm] = useState(false)
  const [refusal, setRefusal] = useState<string>()
  const [is_importing, setImporting] = useState(false)

  const readFile = async (file: File | undefined) => {
    setDocument(undefined)
    setFileError(undefined)
    setRefusal(undefined)
    if (!file) return
    try {
      const parsed = JSON.parse(await file.text()) as ExportDocument
      if (!parsed || typeof parsed !== 'object' || !parsed.checksum || !parsed.count) {
        setFileError('This file is not a venue export. Choose a file downloaded from Export.')
        return
      }
      setDocument(parsed)
    } catch {
      setFileError('This file is not valid JSON. Choose a file downloaded from Export.')
    }
  }

  const total = document?.count ? Object.values(document.count).reduce((sum, one) => sum + one, 0) : 0

  return (
    <Card title="Import" description="Bring another venue's setup into this one.">
      <div className="stack">
        <Alert severity="caution" title="Only into a new, empty venue">
          Import adds the file's staff, roles, player profiles, and module settings in one step. If anything does not
          match, nothing changes. Imported staff need a password reset before they can sign in.
        </Alert>
        <Field label="Export file" error={file_error}>
          {(id) => (
            <input
              id={id}
              className="input"
              type="file"
              accept="application/json,.json"
              onChange={(event) => readFile(event.target.files?.[0])}
            />
          )}
        </Field>
        {document && (
          <dl className="admin-fact">
            <div>
              <dt>From</dt>
              <dd>{document.organization?.display_name ?? 'Unknown venue'}</dd>
            </div>
            <div>
              <dt>Exported</dt>
              <dd>{document.exported_at ? formatDateTime(document.exported_at) : 'Unknown'}</dd>
            </div>
            <div>
              <dt>Records</dt>
              <dd>{total}</dd>
            </div>
          </dl>
        )}
        {refusal && (
          <Alert severity="danger" title="The venue refused this import" onDismiss={() => setRefusal(undefined)}>
            {refusal} Nothing was changed.
          </Alert>
        )}
        <div>
          <Button
            tone="secondary"
            icon={<UploadSimple size={18} aria-hidden />}
            disabled={!document}
            onClick={() => setConfirm(true)}
          >
            Import into this venue
          </Button>
        </div>
      </div>
      <ConfirmDialog
        open={is_confirm}
        title="Import this file?"
        confirm_label="Import"
        tone="danger"
        is_pending={is_importing}
        onClose={() => setConfirm(false)}
        onConfirm={async () => {
          if (!document) return
          setImporting(true)
          try {
            const result = await operatorFetch<{ checksum: string }>('/api/v1/export/import', jsonBody(document))
            onNotice({ severity: 'success', title: 'Import complete', body: `The venue now matches the file. Checksum ${result.checksum}` })
            setDocument(undefined)
          } catch (error) {
            setRefusal(errorMessage(error))
          } finally {
            setImporting(false)
            setConfirm(false)
          }
        }}
      >
        <p>
          This writes {total} records into <strong>this</strong> venue. Use it only on a venue you just created. It
          runs as one step and is checked against the file's checksum.
        </p>
      </ConfirmDialog>
    </Card>
  )
}

function PrivacyCard({ can_manage, onNotice }: { can_manage: boolean; onNotice: (notice: Notice) => void }) {
  const list = useResource(() => operatorFetch<{ privacy_request: PrivacyRequest[] }>('/api/v1/admin/privacy-request'), [])
  const [fulfil, setFulfil] = useState<PrivacyRequest>()
  const [close, setClose] = useState<PrivacyRequest>()
  const [reason, setReason] = useState('')
  const fulfilAction = useAction((one: PrivacyRequest) =>
    operatorFetch<{ privacy_request: PrivacyRequest; bundle: unknown }>(
      `/api/v1/admin/privacy-request/${one.admin_privacy_request_id}/fulfil`,
      jsonBody({}),
    ),
  )
  const closeAction = useAction((one: PrivacyRequest, text: string) =>
    operatorFetch<{ privacy_request: PrivacyRequest }>(
      `/api/v1/admin/privacy-request/${one.admin_privacy_request_id}/close`,
      jsonBody({ reason: text }),
    ),
  )
  const download = useAction(async (one: PrivacyRequest) => {
    const bundle = await operatorFetch<unknown>(`/api/v1/admin/privacy-request/${one.admin_privacy_request_id}/bundle`)
    downloadJson(`privacy-copy-${one.booking_code}.json`, bundle)
    return true
  })

  const who = (one: PrivacyRequest) => one.party_display_name ?? 'this player'

  return (
    <Card
      title="Privacy requests"
      description="Players ask from the “Your data” page on your venue site. A request that matches a booking can be fulfilled; the rest can only be closed."
    >
      {download.error && <Alert severity="danger">{download.error.message}</Alert>}
      <ResourceView resource={list}>
        {(data) =>
          data.privacy_request.length === 0 ? (
            <EmptyState title="No privacy requests" description="When a player asks for a copy of their data or to delete it, it appears here." />
          ) : (
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th scope="col">Request</th>
                    <th scope="col">Booking</th>
                    <th scope="col">Received</th>
                    <th scope="col">Status</th>
                    {can_manage && (
                      <th scope="col">
                        <span className="visually-hidden">Actions</span>
                      </th>
                    )}
                  </tr>
                </thead>
                <tbody>
                  {data.privacy_request.map((one) => (
                    <tr key={one.admin_privacy_request_id}>
                      <td>
                        <Badge tone={one.request_kind === 'erasure' ? 'caution' : 'neutral'}>
                          {one.request_kind === 'erasure' ? 'Delete my data' : 'Copy of my data'}
                        </Badge>
                        <span className="admin-cell-note">
                          {one.is_verified ? `Matched ${one.party_display_name ?? 'player'}` : 'Did not match the booking'} ·{' '}
                          {one.email_mask}
                        </span>
                      </td>
                      <td className="mono">{one.booking_code}</td>
                      <td>{formatDate(one.created_at)}</td>
                      <td>
                        <Badge tone={STATUS_TONE[one.status]}>{titleCase(one.status)}</Badge>
                        {one.resolution_note && <span className="admin-cell-note">{one.resolution_note}</span>}
                      </td>
                      {can_manage && (
                        <td>
                          <div className="admin-action">
                            {one.status === 'received' && one.is_verified && (
                              <Button size="sm" onClick={() => setFulfil(one)}>
                                Fulfil
                              </Button>
                            )}
                            {one.status === 'received' && (
                              <Button tone="quiet" size="sm" onClick={() => setClose(one)}>
                                Close
                              </Button>
                            )}
                            {one.has_bundle && (
                              <Button
                                tone="secondary"
                                size="sm"
                                icon={<DownloadSimple size={16} aria-hidden />}
                                disabled={download.is_pending}
                                onClick={() => download.run(one)}
                              >
                                Download copy
                              </Button>
                            )}
                          </div>
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )
        }
      </ResourceView>

      <ConfirmDialog
        open={fulfil !== undefined}
        title={fulfil?.request_kind === 'erasure' ? `Delete ${fulfil ? who(fulfil) : ''}'s details?` : `Prepare a copy for ${fulfil ? who(fulfil) : ''}?`}
        confirm_label={fulfil?.request_kind === 'erasure' ? 'Delete details' : 'Prepare copy'}
        tone={fulfil?.request_kind === 'erasure' ? 'danger' : 'primary'}
        is_pending={fulfilAction.is_pending}
        error={fulfilAction.error}
        onClose={() => {
          fulfilAction.clearError()
          setFulfil(undefined)
        }}
        onConfirm={async () => {
          if (!fulfil) return
          const result = await fulfilAction.run(fulfil)
          if (!result) return
          if (result.bundle) downloadJson(`privacy-copy-${fulfil.booking_code}.json`, result.bundle)
          onNotice({
            severity: 'success',
            title: fulfil.request_kind === 'erasure' ? 'Player details deleted' : 'Copy prepared and downloaded',
            body: result.privacy_request.resolution_note ?? '',
          })
          setFulfil(undefined)
          list.reload()
        }}
      >
        {fulfil?.request_kind === 'erasure' ? (
          <p>
            This removes their name, email, and phone number from their profile and from booking and registration contact
            details. Bookings, invoices, and orders are kept without their identity, because the venue must keep financial
            records. This cannot be undone.
          </p>
        ) : (
          <p>
            This gathers their profile, bookings, program registrations, check-ins, orders, invoices, and messages into
            one file and downloads it. Send it to the email address on their booking. The copy is kept here for 30 days.
          </p>
        )}
      </ConfirmDialog>

      <ConfirmDialog
        open={close !== undefined}
        title="Close this request without changes?"
        confirm_label="Close request"
        is_pending={closeAction.is_pending}
        error={closeAction.error}
        onClose={() => {
          closeAction.clearError()
          setClose(undefined)
          setReason('')
        }}
        onConfirm={async () => {
          if (!close) return
          const result = await closeAction.run(close, reason)
          if (!result) return
          onNotice({ severity: 'success', title: 'Request closed', body: 'The player sees that it was closed without changes.' })
          setClose(undefined)
          setReason('')
          list.reload()
        }}
      >
        <p>The player's status page will say the request was closed and suggest contacting the venue.</p>
        <TextArea label="Reason (staff only)" value={reason} onChange={(event) => setReason(event.target.value)} rows={3} />
      </ConfirmDialog>
    </Card>
  )
}
