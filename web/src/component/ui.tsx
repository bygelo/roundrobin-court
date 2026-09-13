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
import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode, SelectHTMLAttributes, TextareaHTMLAttributes } from 'react'
import { useId } from 'react'
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
      {error && <p className="field__error">{error}</p>}
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
      {(id) => <input id={id} className="input" aria-invalid={error ? true : undefined} {...rest} />}
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
  return (
    <div className="tabs" role="tablist" aria-label={label}>
      {option.map((one) => (
        <button
          key={one.value}
          type="button"
          role="tab"
          aria-selected={one.value === value}
          className={cx('tabs__tab', one.value === value && 'is-active')}
          onClick={() => onChange(one.value)}
        >
          {one.label}
        </button>
      ))}
    </div>
  )
}

/** A modal dialog using the native <dialog> element, so focus and Escape work. */
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
  return open ? (
    <div className="dialog-backdrop" onClick={onClose}>
      <div
        className="dialog"
        role="dialog"
        aria-modal="true"
        aria-label={typeof title === 'string' ? title : undefined}
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          if (event.key === 'Escape') onClose()
        }}
      >
        <header className="dialog__header">
          <h2>{title}</h2>
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
