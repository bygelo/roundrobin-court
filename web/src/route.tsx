// A small history router. Patterns use `:name` segments.

import { useEffect, useState, type AnchorHTMLAttributes, type MouseEvent } from 'react'

const CHANGE = 'court:navigate'

export function navigate(to: string, option: { replace?: boolean } = {}) {
  if (option.replace) window.history.replaceState(null, '', to)
  else window.history.pushState(null, '', to)
  window.dispatchEvent(new Event(CHANGE))
  window.scrollTo({ top: 0 })
}

export function usePath(): string {
  const [path, setPath] = useState(() => window.location.pathname)
  useEffect(() => {
    const update = () => setPath(window.location.pathname)
    window.addEventListener('popstate', update)
    window.addEventListener(CHANGE, update)
    return () => {
      window.removeEventListener('popstate', update)
      window.removeEventListener(CHANGE, update)
    }
  }, [])
  return path
}

export function useQuery(): URLSearchParams {
  usePath()
  return new URLSearchParams(window.location.search)
}

/** Match `/v/:organization_code/shop` against a path. Returns params, or undefined. */
export function matchPattern(pattern: string, path: string): Record<string, string> | undefined {
  const pattern_part = pattern.split('/').filter(Boolean)
  const path_part = path.split('/').filter(Boolean)
  if (pattern_part.length !== path_part.length) return undefined
  const param: Record<string, string> = {}
  for (let index = 0; index < pattern_part.length; index += 1) {
    const expected = pattern_part[index]!
    const actual = path_part[index]!
    if (expected.startsWith(':')) param[expected.slice(1)] = decodeURIComponent(actual)
    else if (expected !== actual) return undefined
  }
  return param
}

export function Link({ to, onClick, ...rest }: AnchorHTMLAttributes<HTMLAnchorElement> & { to: string }) {
  const handle = (event: MouseEvent<HTMLAnchorElement>) => {
    onClick?.(event)
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey) return
    event.preventDefault()
    navigate(to)
  }
  return <a href={to} onClick={handle} {...rest} />
}
