import {
  CalendarCheck,
  ChartBar,
  Code,
  Database,
  Gear,
  List,
  Monitor,
  Palette,
  Plugs,
  PuzzlePiece,
  QrCode,
  Trophy,
  ShoppingBag,
  SignOut,
  SquaresFour,
  Storefront,
  UsersThree,
  IdentificationCard,
  ChatCircleText,
  ArrowsClockwise,
  X,
} from '@phosphor-icons/react'
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { SESSION_EXPIRED, operatorFetch, readSession, writeSession } from '../api.ts'
import { Alert, Button, Loading } from '../component/ui.tsx'
import { useResource } from '../hook.ts'
import { PAGE, type NavGroup, type PageEntry } from '../registry.ts'
import { Link, navigate, usePath } from '../route.tsx'
import { OperatorSessionContext, type Capability } from '../session.tsx'

const ICON: Record<string, ReactNode> = {
  board: <SquaresFour size={20} aria-hidden />,
  booking: <CalendarCheck size={20} aria-hidden />,
  arrival: <QrCode size={20} aria-hidden />,
  play: <ArrowsClockwise size={20} aria-hidden />,
  program: <UsersThree size={20} aria-hidden />,
  score: <Trophy size={20} aria-hidden />,
  display: <Monitor size={20} aria-hidden />,
  shop: <ShoppingBag size={20} aria-hidden />,
  member: <IdentificationCard size={20} aria-hidden />,
  insight: <ChartBar size={20} aria-hidden />,
  venue: <Gear size={20} aria-hidden />,
  studio: <Palette size={20} aria-hidden />,
  message: <ChatCircleText size={20} aria-hidden />,
  connect: <Plugs size={20} aria-hidden />,
  staff: <UsersThree size={20} aria-hidden />,
  module: <PuzzlePiece size={20} aria-hidden />,
  developer: <Code size={20} aria-hidden />,
  data: <Database size={20} aria-hidden />,
}

const GROUP_ORDER: NavGroup[] = ['Today', 'Play', 'Business', 'Venue', 'Connect', 'Admin']

export function OperatorShell({ entry, children }: { entry?: PageEntry; children: ReactNode }) {
  const [session, setSession] = useState(readSession)
  const [is_nav_open, setNavOpen] = useState(false)
  const path = usePath()

  useEffect(() => {
    const expire = () => setSession(undefined)
    window.addEventListener(SESSION_EXPIRED, expire)
    return () => window.removeEventListener(SESSION_EXPIRED, expire)
  }, [])

  useEffect(() => {
    if (!session) navigate(`/sign-in?next=${encodeURIComponent(window.location.pathname)}`, { replace: true })
  }, [session])

  useEffect(() => setNavOpen(false), [path])

  // Mobile nav: opening moves focus to the first link; Escape closes and returns
  // focus to the toggle.
  const menu_ref = useRef<HTMLButtonElement>(null)
  const nav_ref = useRef<HTMLElement>(null)
  useEffect(() => {
    if (!is_nav_open) return
    const frame = window.requestAnimationFrame(() => nav_ref.current?.querySelector<HTMLElement>('a, button')?.focus())
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      setNavOpen(false)
      menu_ref.current?.focus()
    }
    document.addEventListener('keydown', onKey)
    return () => {
      window.cancelAnimationFrame(frame)
      document.removeEventListener('keydown', onKey)
    }
  }, [is_nav_open])

  const capability = useResource(
    () => (session ? operatorFetch<Capability>('/api/v1/capability') : Promise.resolve(undefined)),
    [session?.token],
  )

  // Staff whose password an owner issued are asked to set their own. A banner,
  // not a forced redirect: the desk must never be locked out mid-shift.
  const account = useResource(
    () =>
      session
        ? operatorFetch<{ account: { is_secret_temporary: boolean } }>('/api/v1/admin/account')
            .then((one) => one.account)
            .catch(() => ({ is_secret_temporary: false }))
        : Promise.resolve({ is_secret_temporary: false }),
    [session?.token, path === '/operator/account'],
  )

  const signOut = useCallback(() => {
    writeSession(undefined)
    setSession(undefined)
  }, [])

  const context = useMemo(() => {
    if (!session || !capability.data) return undefined
    const data = capability.data
    return {
      session,
      capability: data,
      isEnabled: (module_code: string) => data.module.some((one) => one.module_code === module_code && one.is_enabled),
      can: (capability_code: string) => data.capability.includes(capability_code),
      refreshCapability: capability.reload,
      signOut,
    }
  }, [session, capability.data, capability.reload, signOut])

  useEffect(() => {
    document.title = entry ? `${entry.title} · ${session?.organization_code ?? ''} · court` : 'court'
  }, [entry, session?.organization_code])

  if (!session) return null
  if (!context) {
    return (
      <div className="operator-loading">
        {capability.error ? (
          <Alert severity="danger" title="Could not reach the venue">
            <p>{capability.error.message}</p>
            <Button tone="secondary" size="sm" onClick={capability.reload}>
              Try again
            </Button>
          </Alert>
        ) : (
          <Loading label="Opening the venue console…" />
        )}
      </div>
    )
  }

  const visible = PAGE.filter(
    (one) => one.surface === 'operator' && one.group && (!one.module_code || context.isEnabled(one.module_code)),
  )
  const is_entry_disabled = entry?.module_code !== undefined && !context.isEnabled(entry.module_code)

  return (
    <OperatorSessionContext.Provider value={context}>
      <div className={`operator ${is_nav_open ? 'is-nav-open' : ''}`}>
        <a href="#main" className="skip-link">
          Skip to content
        </a>
        <header className="operator__bar">
          <button
            ref={menu_ref}
            type="button"
            className="operator__menu"
            aria-label="Navigation"
            aria-controls="operator-nav"
            aria-expanded={is_nav_open}
            onClick={() => setNavOpen((value) => !value)}
          >
            {is_nav_open ? <X size={22} aria-hidden /> : <List size={22} aria-hidden />}
          </button>
          <Link to="/operator/board" className="wordmark">
            round<span>robin</span> court
          </Link>
          <span className="operator__venue" title="Venue">
            <Storefront size={16} aria-hidden /> {session.organization_code}
          </span>
        </header>
        <nav className="operator__nav" aria-label="Console" id="operator-nav" ref={nav_ref}>
          {GROUP_ORDER.map((group) => {
            const item = visible.filter((one) => one.group === group)
            if (item.length === 0) return null
            return (
              <div className="nav-group" key={group}>
                <p className="nav-group__label">{group}</p>
                {item.map((one) => (
                  <Link
                    key={one.pattern}
                    to={one.pattern}
                    className={`nav-item ${one.pattern === path ? 'is-active' : ''}`}
                    aria-current={one.pattern === path ? 'page' : undefined}
                  >
                    {ICON[one.icon ?? ''] ?? <SquaresFour size={20} aria-hidden />}
                    {one.title}
                  </Link>
                ))}
              </div>
            )
          })}
          <div className="nav-group nav-group--foot">
            <Link to={`/v/${session.organization_code}`} className="nav-item">
              <Storefront size={20} aria-hidden /> Public site
            </Link>
            <Link
              to="/operator/account"
              className={`nav-item ${path === '/operator/account' ? 'is-active' : ''}`}
              aria-current={path === '/operator/account' ? 'page' : undefined}
            >
              <UsersThree size={20} aria-hidden /> Your account
            </Link>
            <button type="button" className="nav-item" onClick={signOut}>
              <SignOut size={20} aria-hidden /> Sign out {session.actor_code}
            </button>
          </div>
        </nav>
        <main className="operator__main" id="main" tabIndex={-1}>
          {account.data?.is_secret_temporary && path !== '/operator/account' && (
            <Alert severity="caution" title="Set your own password">
              You are signed in with a password someone else gave you.{' '}
              <Link to="/operator/account">Change it now</Link>
            </Alert>
          )}
          {is_entry_disabled ? (
            <Alert severity="caution" title="This module is turned off for your venue">
              An owner can turn it back on under Admin → Modules. Nothing was deleted.
            </Alert>
          ) : (
            children
          )}
        </main>
      </div>
    </OperatorSessionContext.Provider>
  )
}
