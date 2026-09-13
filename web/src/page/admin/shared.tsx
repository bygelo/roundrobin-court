// Pieces the admin screens share: a confirm dialog, a shown-once secret, and
// a JSON download. Lane-local; nothing outside web/src/page/admin imports it.

import { Check, Copy } from '@phosphor-icons/react'
import { useState, type ReactNode } from 'react'
import { Alert, Button, Dialog, ErrorAlert } from '../../component/ui.tsx'
import './admin.css'

export function joinName(name: string[]): string {
  if (name.length <= 1) return name[0] ?? ''
  if (name.length === 2) return `${name[0]} and ${name[1]}`
  return `${name.slice(0, -1).join(', ')}, and ${name[name.length - 1]}`
}

export function ConfirmDialog({
  open,
  title,
  confirm_label,
  tone = 'primary',
  is_pending,
  error,
  onConfirm,
  onClose,
  children,
}: {
  open: boolean
  title: string
  confirm_label: string
  tone?: 'primary' | 'danger'
  is_pending: boolean
  error?: Error | undefined
  onConfirm: () => void
  onClose: () => void
  children: ReactNode
}) {
  return (
    <Dialog
      open={open}
      title={title}
      onClose={onClose}
      footer={
        <>
          <Button tone="secondary" onClick={onClose} disabled={is_pending}>
            Cancel
          </Button>
          <Button tone={tone} onClick={onConfirm} disabled={is_pending}>
            {is_pending ? 'Working…' : confirm_label}
          </Button>
        </>
      }
    >
      <div className="stack">
        <ErrorAlert error={error} />
        {children}
      </div>
    </Dialog>
  )
}

export function CopyButton({ value, label = 'Copy' }: { value: string; label?: string }) {
  const [is_copied, setCopied] = useState(false)
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 2000)
    } catch {
      setCopied(false)
    }
  }
  return (
    <Button
      tone="secondary"
      size="sm"
      icon={is_copied ? <Check size={16} aria-hidden /> : <Copy size={16} aria-hidden />}
      onClick={copy}
    >
      {is_copied ? 'Copied' : label}
    </Button>
  )
}

/** A credential shown exactly once, selectable and copyable, with the warning beside it. */
export function SecretReveal({ label, value, warning }: { label: string; value: string; warning: ReactNode }) {
  return (
    <div className="stack">
      <Alert severity="caution" title="Shown only once">
        {warning}
      </Alert>
      <div className="admin-secret">
        <code className="mono admin-secret__value" aria-label={label}>
          {value}
        </code>
        <CopyButton value={value} />
      </div>
    </div>
  )
}

export function downloadJson(file_name: string, value: unknown) {
  const blob = new Blob([`${JSON.stringify(value, null, 2)}\n`], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = file_name
  document.body.appendChild(link)
  link.click()
  link.remove()
  URL.revokeObjectURL(url)
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
