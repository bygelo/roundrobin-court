// Small pieces shared by the three Connections tabs.

import { Copy } from '@phosphor-icons/react'
import { useState, type ReactNode } from 'react'
import { Button, Dialog, Field } from '../../component/ui.tsx'

export function ConfirmDialog({
  open,
  title,
  children,
  confirm_label,
  tone = 'danger',
  is_pending,
  onConfirm,
  onClose,
}: {
  open: boolean
  title: string
  children: ReactNode
  confirm_label: string
  tone?: 'danger' | 'primary'
  is_pending: boolean
  onConfirm: () => void
  onClose: () => void
}) {
  return (
    <Dialog
      open={open}
      title={title}
      onClose={onClose}
      footer={
        <>
          <Button tone="quiet" onClick={onClose}>
            Cancel
          </Button>
          <Button tone={tone} onClick={onConfirm} disabled={is_pending} autoFocus>
            {is_pending ? 'Working…' : confirm_label}
          </Button>
        </>
      }
    >
      {children}
    </Dialog>
  )
}

/** A read-only value with a copy button — for a secret or link shown once. */
export function CopyField({ label, value }: { label: string; value: string }) {
  const [is_copied, setCopied] = useState(false)
  return (
    <Field label={label}>
      {(id) => (
        <div className="connect-copy">
          <input
            id={id}
            className="input mono"
            readOnly
            value={value}
            onFocus={(event) => event.currentTarget.select()}
          />
          <Button
            tone="secondary"
            icon={<Copy size={16} aria-hidden />}
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(value)
                setCopied(true)
                window.setTimeout(() => setCopied(false), 2000)
              } catch {
                document.getElementById(id)?.focus()
              }
            }}
          >
            {is_copied ? 'Copied' : 'Copy'}
          </Button>
        </div>
      )}
    </Field>
  )
}
