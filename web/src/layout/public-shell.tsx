import { createContext, useContext, useEffect, useState, type CSSProperties, type ReactNode } from 'react'
import { Loading } from '../component/ui.tsx'
import { useResource } from '../hook.ts'
import { loadSite, type PublicSite } from '../public-site.ts'
import { Link, usePath } from '../route.tsx'

const PublicSiteContext = createContext<PublicSite | undefined>(undefined)

/** The published venue site, for any screen rendered inside the public shell. */
export function usePublicSite(): PublicSite {
  const value = useContext(PublicSiteContext)
  if (!value) throw new Error('usePublicSite must be used inside the public site')
  return value
}

const NAV_PATH: Record<PublicSite['nav'][number]['nav_code'], (organization_code: string) => string> = {
  book: (code) => `/v/${code}`,
  program: (code) => `/v/${code}/program`,
  play: (code) => `/v/${code}/program`,
  shop: (code) => `/v/${code}/shop`,
}

const RADIUS: Record<PublicSite['token']['radius'], string> = { square: '4px', soft: '12px', round: '999px' }

export function PublicShell({ organization_code, children }: { organization_code: string; children: ReactNode }) {
  const site = useResource(() => loadSite(organization_code), [organization_code])
  const path = usePath()
  const [is_menu_open, setMenuOpen] = useState(false)
  useEffect(() => setMenuOpen(false), [path])

  useEffect(() => {
    if (site.data) document.title = site.data.display_name
  }, [site.data])

  if (!site.data) return <Loading label="Opening the venue…" />
  const data = site.data
  const style = {
    '--brand-accent': data.token.accent,
    '--brand-action': data.token.action,
    '--brand-heading': `"${data.token.heading_font}"`,
    '--brand-radius': RADIUS[data.token.radius],
  } as CSSProperties

  return (
    <PublicSiteContext.Provider value={data}>
      <div className={`public public--${data.template_code}`} style={style}>
        <a href="#main" className="skip-link">
          Skip to content
        </a>
        <header className="public__header">
          <Link to={`/v/${organization_code}`} className="public__wordmark">
            {data.display_name}
          </Link>
          <button
            type="button"
            className="public__menu"
            aria-expanded={is_menu_open}
            onClick={() => setMenuOpen((value) => !value)}
          >
            Menu
          </button>
          <nav className={`public__nav ${is_menu_open ? 'is-open' : ''}`} aria-label="Venue">
            {data.nav.map((one) => {
              const to = NAV_PATH[one.nav_code](organization_code)
              return (
                <Link key={one.nav_code} to={to} aria-current={to === path ? 'page' : undefined}>
                  {one.label}
                </Link>
              )
            })}
          </nav>
        </header>
        <main className="public__main" id="main">
          {children}
        </main>
        <footer className="public__footer">
          <div>
            <strong>{data.display_name}</strong>
            {data.content.address && <p>{data.content.address}</p>}
            {data.content.contact && <p>{data.content.contact}</p>}
          </div>
          <div className="public__footer-link">
            <Link to={`/v/${organization_code}/privacy`}>Your data</Link>
            <Link to="/operator/board">Staff</Link>
          </div>
        </footer>
      </div>
    </PublicSiteContext.Provider>
  )
}
