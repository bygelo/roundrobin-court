// The UI kit every screen composes. Follows the OS design direction:
//   - capsule for one-line controls, card only when content has internal layout
//     or the whole rectangle is one target, plain region otherwise;
//   - badge states an attribute (no icon, not dismissible); alert reports the
//     consequence of an action (always an icon, role=status or role=alert);
//   - one solid + one outline per action row, never two solids.

import {
  CheckCircle,
  Info,
  Warning,
  WarningOctagon,
  X,
} from '@phosphor-icons/react'
import type {
  ButtonHTMLAttributes,
  InputHTMLAttributes,
  KeyboardEvent,
  ReactNode,
  SelectHTMLAttributes,
  TextareaHTMLAttributes,
} from 'react'
import { useEffect, useId, useRef } from 'react'
import { Link } from '../route.tsx'

type Tone = 'primary' | 'secondary' | 'quiet' | 'danger'
type Size = 'sm' | 'md' | 'lg'

function cx(...name: (string | false | undefined | null)[]): string {
  return name.filter(Boolean).join(' ')
}

export function Button({
  tone = 'primary',
  size = 'md',
  icon,
  className,
  children,
  type = 'button',
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { tone?: Tone; size?: Size; icon?: ReactNode }) {
  return (
    <button type={type} className={cx('button', `button--${tone}`, `button--${size}`, className)} {...rest}>
      {icon}
      {children}
    </button>
  )
}

export function ButtonLink({
  to,
  tone = 'primary',
  size = 'md',
  icon,
  children,
  className,
}: {
  to: string
  tone?: Tone
  size?: Size
  icon?: ReactNode
  children: ReactNode
  className?: string
}) {
  return (
    <Link to={to} className={cx('button', `button--${tone}`, `button--${size}`, className)}>
      {icon}
      {children}
    </Link>
  )
}

export type BadgeTone = 'neutral' | 'info' | 'success' | 'caution' | 'danger'

export function Badge({ tone = 'neutral', children }: { tone?: BadgeTone; children: ReactNode }) {
  return <span className={cx('badge', `badge--${tone}`)}>{children}</span>
}

export type AlertSeverity = 'info' | 'success' | 'caution' | 'danger'

const ALERT_ICON: Record<AlertSeverity, ReactNode> = {
  info: <Info size={20} weight="fill" aria-hidden />,
  success: <CheckCircle size={20} weight="fill" aria-hidden />,
  caution: <Warning size={20} weight="fill" aria-hidden />,
  danger: <WarningOctagon size={20} weight="fill" aria-hidden />,
}

export function Alert({
  severity = 'info',
  title,
  children,
  onDismiss,
}: {
  severity?: AlertSeverity
  title?: string
  children?: ReactNode
  onDismiss?: () => void
}) {
  return (
    <div className={cx('alert', `alert--${severity}`)} role={severity === 'danger' ? 'alert' : 'status'}>
      {ALERT_ICON[severity]}
      <div className="alert__body">
        {title && <strong>{title}</strong>}
        {children && <div>{children}</div>}
      </div>
      {onDismiss && (
        <button type="button" className="alert__dismiss" onClick={onDismiss} aria-label="Dismiss">
          <X size={16} aria-hidden />
        </button>
      )}
    </div>
  )
}

/** Shows an action's refusal as a sentence. Renders nothing when there is no error. */
export function ErrorAlert({ error, onDismiss }: { error: Error | undefined; onDismiss?: () => void }) {
  if (!error) return null
  return (
    <Alert severity="danger" {...(onDismiss ? { onDismiss } : {})}>
      {error.message}
    </Alert>
  )
}

export function Card({
  title,
  description,
  action,
  children,
  className,
}: {
  title?: ReactNode
  description?: ReactNode
  action?: ReactNode
  children?: ReactNode
  className?: string
}) {
  return (
    <section className={cx('card', className)}>
      {(title || action) && (
        <header className="card__header">
          <div>
            {title && <h2 className="card__title">{title}</h2>}
            {description && <p className="card__description">{description}</p>}
          </div>
          {action && <div className="card__action">{action}</div>}
        </header>
      )}
      {children}
    </section>
  )
}

export function PageHeader({
  eyebrow,
  title,
  description,
  action,
}: {
  eyebrow?: ReactNode
  title: ReactNode
  description?: ReactNode
  action?: ReactNode
}) {
  return (
    <header className="page-header">
      <div>
        {eyebrow && <p className="eyebrow">{eyebrow}</p>}
        <h1>{title}</h1>
        {description && <p className="page-header__description">{description}</p>}
      </div>
      {action && <div className="page-header__action">{action}</div>}
    </header>
  )
}

export function Field({
  label,
  hint,
  error,
  children,
}: {
  label: ReactNode
  hint?: ReactNode
  error?: string | undefined
  children: (id: string) => ReactNode
}) {
  const id = useId()
  return (
    <div className={cx('field', error && 'field--invalid')}>
      <label htmlFor={id} className="field__label">
        {label}
      </label>
      {children(id)}
      {hint && !error && <p className="field__hint">{hint}</p>}
      {error && <p className="field__error" id={`${id}-error`}>{error}</p>}
    </div>
  )
}

export function TextInput({
  label,
  hint,
  error,
  ...rest
}: InputHTMLAttributes<HTMLInputElement> & { label: ReactNode; hint?: ReactNode; error?: string | undefined }) {
  return (
    <Field label={label} hint={hint} error={error}>
      {(id) => (
        <input
          id={id}
          className="input"
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? `${id}-error` : undefined}
          {...rest}
        />
      )}
    </Field>
  )
}

export function SelectInput({
  label,
  hint,
  option,
  ...rest
}: SelectHTMLAttributes<HTMLSelectElement> & {
  label: ReactNode
  hint?: ReactNode
  option: { value: string; label: string }[]
}) {
  return (
    <Field label={label} hint={hint}>
      {(id) => (
        <select id={id} className="input" {...rest}>
          {option.map((one) => (
            <option key={one.value} value={one.value}>
              {one.label}
            </option>
          ))}
        </select>
      )}
    </Field>
  )
}

export function TextArea({
  label,
  hint,
  ...rest
}: TextareaHTMLAttributes<HTMLTextAreaElement> & { label: ReactNode; hint?: ReactNode }) {
  return (
    <Field label={label} hint={hint}>
      {(id) => <textarea id={id} className="input input--area" {...rest} />}
    </Field>
  )
}

export function Checkbox({ label, ...rest }: InputHTMLAttributes<HTMLInputElement> & { label: ReactNode }) {
  return (
    <label className="checkbox">
      <input type="checkbox" {...rest} />
      <span>{label}</span>
    </label>
  )
}

export function EmptyState({
  title,
  description,
  action,
}: {
  title: ReactNode
  description?: ReactNode
  action?: ReactNode
}) {
  return (
    <div className="empty-state">
      <p className="empty-state__title">{title}</p>
      {description && <p className="empty-state__description">{description}</p>}
      {action && <div className="empty-state__action">{action}</div>}
    </div>
  )
}

export function Stat({ label, value, hint }: { label: ReactNode; value: ReactNode; hint?: ReactNode }) {
  return (
    <div className="stat">
      <p className="stat__label">{label}</p>
      <p className="stat__value">{value}</p>
      {hint && <p className="stat__hint">{hint}</p>}
    </div>
  )
}

export function Loading({ label = 'Loading…' }: { label?: string }) {
  return (
    <div className="loading" role="status" aria-live="polite">
      <span className="loading__dot" aria-hidden />
      {label}
    </div>
  )
}

/** Standard load boundary: spinner, refusal with retry, or the content. */
export function ResourceView<T>({
  resource,
  children,
}: {
  resource: { data: T | undefined; error: Error | undefined; is_loading: boolean; reload: () => void }
  children: (data: T) => ReactNode
}) {
  if (resource.error && resource.data === undefined) {
    return (
      <Alert severity="danger" title="Could not load this">
        <p>{resource.error.message}</p>
        <Button tone="secondary" size="sm" onClick={resource.reload}>
          Try again
        </Button>
      </Alert>
    )
  }
  if (resource.data === undefined) return <Loading />
  return <>{children(resource.data)}</>
}

export function Toolbar({ children }: { children: ReactNode }) {
  return <div className="toolbar">{children}</div>
}

export function Tabs<T extends string>({
  value,
  option,
  onChange,
  label,
}: {
  value: T
  option: { value: T; label: string }[]
  onChange: (value: T) => void
  label: string
}) {
  const list_ref = useRef<HTMLDivElement>(null)
  // ARIA tab pattern: one tab stop (the selected tab); arrows, Home and End move
  // between tabs and select as they go.
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const index = option.findIndex((one) => one.value === value)
    const last = option.length - 1
    const next =
      event.key === 'ArrowRight' ? (index >= last ? 0 : index + 1)
      : event.key === 'ArrowLeft' ? (index <= 0 ? last : index - 1)
      : event.key === 'Home' ? 0
      : event.key === 'End' ? last
      : undefined
    if (next === undefined || option.length === 0) return
    event.preventDefault()
    onChange(option[next]!.value)
    list_ref.current?.querySelectorAll<HTMLButtonElement>('[role=tab]')[next]?.focus()
  }
  const has_selected = option.some((one) => one.value === value)
  return (
    <div className="tabs" role="tablist" aria-label={label} ref={list_ref} onKeyDown={onKeyDown}>
      {option.map((one, index) => {
        const is_selected = one.value === value
        return (
          <button
            key={one.value}
            type="button"
            role="tab"
            aria-selected={is_selected}
            tabIndex={is_selected || (!has_selected && index === 0) ? 0 : -1}
            className={cx('tabs__tab', is_selected && 'is-active')}
            onClick={() => onChange(one.value)}
          >
            {one.label}
          </button>
        )
      })}
    </div>
  )
}

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]):not([type=hidden]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"]), summary'

function focusableIn(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
    (one) => one.getClientRects().length > 0 && !one.closest('[inert]'),
  )
}

/**
 * A modal dialog. Focus moves in when it opens (to an autofocus field, else the
 * first form control, else the dialog itself), Tab is trapped inside, Escape
 * closes it, and focus returns to whatever opened it. Labelled by its title.
 */
export function Dialog({
  open,
  title,
  onClose,
  children,
  footer,
}: {
  open: boolean
  title: ReactNode
  onClose: () => void
  children: ReactNode
  footer?: ReactNode
}) {
  const title_id = useId()
  const dialog_ref = useRef<HTMLDivElement>(null)
  const opener_ref = useRef<Element | null>(null)
  const was_open_ref = useRef(false)
  const close_ref = useRef(onClose)
  close_ref.current = onClose

  // Remember the opener during render, before any autoFocus child steals focus.
  if (open && !was_open_ref.current && typeof document !== 'undefined') {
    const active = document.activeElement
    if (active && active !== document.body && !dialog_ref.current?.contains(active)) opener_ref.current = active
  }

  useEffect(() => {
    if (!open) return
    was_open_ref.current = true
    const dialog = dialog_ref.current
    if (dialog && !dialog.contains(document.activeElement)) {
      const body = dialog.querySelector<HTMLElement>('.dialog__body')
      const preferred =
        dialog.querySelector<HTMLElement>('[autofocus], [data-autofocus]') ??
        (body ? focusableIn(body).find((one) => one.matches('input, select, textarea')) : undefined)
      ;(preferred ?? dialog).focus()
    }
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape' && !event.defaultPrevented) {
        event.stopPropagation()
        close_ref.current()
      }
    }
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('keydown', onKey)
      was_open_ref.current = false
      const opener = opener_ref.current
      opener_ref.current = null
      // Return focus after the dialog is gone. If the opener went away with it
      // (a removed row), fall back to the page's main landmark.
      window.setTimeout(() => {
        if (document.activeElement && document.activeElement !== document.body && document.contains(document.activeElement)) return
        if (opener instanceof HTMLElement && opener.isConnected) opener.focus()
        else document.getElementById('main')?.focus()
      }, 0)
    }
  }, [open])

  const trap = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'Tab' || !dialog_ref.current) return
    const item = focusableIn(dialog_ref.current)
    if (item.length === 0) {
      event.preventDefault()
      return
    }
    const first = item[0]!
    const last = item[item.length - 1]!
    const active = document.activeElement
    if (event.shiftKey && (active === first || active === dialog_ref.current)) {
      event.preventDefault()
      last.focus()
    } else if (!event.shiftKey && active === last) {
      event.preventDefault()
      first.focus()
    }
  }

  return open ? (
    <div className="dialog-backdrop" onClick={onClose}>
      <div
        ref={dialog_ref}
        className="dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={title_id}
        tabIndex={-1}
        onClick={(event) => event.stopPropagation()}
        onKeyDown={trap}
      >
        <header className="dialog__header">
          <h2 id={title_id}>{title}</h2>
          <button type="button" className="alert__dismiss" onClick={onClose} aria-label="Close">
            <X size={18} aria-hidden />
          </button>
        </header>
        <div className="dialog__body">{children}</div>
        {footer && <footer className="dialog__footer">{footer}</footer>}
      </div>
    </div>
  ) : null
}
