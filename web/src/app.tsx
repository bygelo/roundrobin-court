import { Suspense, useEffect } from 'react'
import { OperatorShell } from './layout/operator-shell.tsx'
import { PublicShell } from './layout/public-shell.tsx'
import { Loading } from './component/ui.tsx'
import NotFound from './page/not-found.tsx'
import SignIn from './page/sign-in.tsx'
import { PAGE } from './registry.ts'
import { matchPattern, navigate, usePath } from './route.tsx'

export const DEFAULT_ORGANIZATION_CODE: string = import.meta.env['VITE_DEFAULT_ORGANIZATION'] ?? 'sideout'

function Redirect({ to }: { to: string }) {
  useEffect(() => navigate(to, { replace: true }), [to])
  return null
}

export function App() {
  const path = usePath().replace(/\/+$/, '') || '/'

  if (path === '/') return <Redirect to={`/v/${DEFAULT_ORGANIZATION_CODE}`} />
  if (path === '/operator') return <Redirect to="/operator/board" />
  if (path === '/sign-in') return <SignIn />

  for (const entry of PAGE) {
    const param = matchPattern(entry.pattern, path)
    if (!param) continue
    const Page = entry.component
    const content = (
      <Suspense fallback={<Loading />}>
        <Page param={param} />
      </Suspense>
    )
    if (entry.surface === 'operator') {
      return (
        <OperatorShell entry={entry} key="operator">
          {content}
        </OperatorShell>
      )
    }
    if (entry.surface === 'public') {
      return (
        <PublicShell organization_code={param['organization_code']!} key={`public-${param['organization_code']}`}>
          {content}
        </PublicShell>
      )
    }
    return <div className="bare">{content}</div>
  }

  if (path.startsWith('/operator/')) {
    return (
      <OperatorShell key="operator">
        <NotFound />
      </OperatorShell>
    )
  }
  return <NotFound />
}
