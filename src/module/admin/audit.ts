// Audit for every admin action (R04): who, what, which target, when.
//
// recordAuditEvent (kernel) has no auth_session_id parameter, and R04 asks
// that the row name the acting session. The column exists on audit_event for
// exactly this, so admin writes it directly — null for an API key, whose id is
// not an auth_session row.

import type { Session, TenantContext, Uuid } from '@bygelo/roundrobin-kernel'

export type AdminAuditInput = {
  event_code: string
  subject_table: string
  subject_id?: Uuid | null
  /** Human sentence shown in recent activity. Must not contain a secret. */
  summary: string
  detail?: Record<string, unknown>
}

export async function recordAdminAudit(
  tenant: TenantContext,
  session: Session,
  is_api_key: boolean,
  input: AdminAuditInput,
): Promise<void> {
  const [actor] = await tenant.query<{ actor_code: string }[]>`
    SELECT actor_code FROM actor
    WHERE organization_id = ${tenant.organization_id} AND actor_id = ${session.actor_id}`
  const detail = {
    summary: input.summary,
    acting_actor_id: session.actor_id,
    ...(is_api_key ? { api_key_id: session.auth_session_id } : {}),
    ...(input.detail ?? {}),
  }
  await tenant.query`
    INSERT INTO audit_event (
      organization_id, auth_session_id, actor_label, event_code, subject_table, subject_id, detail
    ) VALUES (
      ${tenant.organization_id},
      ${is_api_key ? null : session.auth_session_id},
      ${actor?.actor_code ?? 'unknown'},
      ${input.event_code},
      ${input.subject_table},
      ${input.subject_id ?? null},
      ${tenant.query.json(detail as never)}
    )`
}

export type AuditView = {
  audit_event_id: string
  event_code: string
  subject_table: string
  summary: string
  actor_display_name: string
  created_at: Date
}

export async function listAudit(tenant: TenantContext, limit_count: number): Promise<AuditView[]> {
  const bounded = Math.min(Math.max(Math.trunc(limit_count) || 50, 1), 200)
  return tenant.query<AuditView[]>`
    SELECT ae.audit_event_id::text AS audit_event_id,
           ae.event_code,
           ae.subject_table,
           COALESCE(ae.detail->>'summary', replace(ae.event_code, '.', ' ')) AS summary,
           COALESCE(session_actor.display_name, detail_actor.display_name,
                    label_actor.display_name, ae.actor_label) AS actor_display_name,
           ae.created_at
    FROM audit_event ae
    LEFT JOIN auth_session s
      ON s.organization_id = ae.organization_id AND s.auth_session_id = ae.auth_session_id
    LEFT JOIN actor session_actor
      ON session_actor.organization_id = ae.organization_id AND session_actor.actor_id = s.actor_id
    LEFT JOIN actor detail_actor
      ON detail_actor.organization_id = ae.organization_id
     AND detail_actor.actor_id::text = ae.detail->>'acting_actor_id'
    LEFT JOIN actor label_actor
      ON label_actor.organization_id = ae.organization_id AND label_actor.actor_code = ae.actor_label
    WHERE ae.organization_id = ${tenant.organization_id}
    ORDER BY ae.created_at DESC, ae.audit_event_id DESC
    LIMIT ${bounded}`
}
