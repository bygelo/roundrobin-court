import { useState, type FormEvent } from 'react'
import { signInOperator } from '../api.ts'
import { Button, ErrorAlert, TextInput } from '../component/ui.tsx'
import { useAction } from '../hook.ts'
import { navigate, useQuery } from '../route.tsx'

export default function SignIn() {
  const query = useQuery()
  const [organization_code, setOrganization] = useState(query.get('venue') ?? 'sideout')
  const [actor_code, setActor] = useState('')
  const [secret, setSecret] = useState('')
  const action = useAction(signInOperator)

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    const session = await action.run({ organization_code: organization_code.trim(), actor_code: actor_code.trim(), secret })
    if (session) {
      const next = query.get('next')
      navigate(next && next.startsWith('/operator') ? next : '/operator/board', { replace: true })
    }
  }

  return (
    <main className="sign-in" id="main">
      <form className="sign-in__panel" onSubmit={submit} aria-labelledby="sign-in-title">
        <p className="wordmark">
          round<span>robin</span> court
        </p>
        <h1 id="sign-in-title">Staff sign in</h1>
        <p className="sign-in__lead">Run the courts, the queue, and the counter from one console.</p>
        <ErrorAlert error={action.error} onDismiss={action.clearError} />
        <TextInput
          label="Venue code"
          value={organization_code}
          onChange={(event) => setOrganization(event.target.value)}
          autoComplete="organization"
          required
        />
        <TextInput
          label="Staff code"
          value={actor_code}
          onChange={(event) => setActor(event.target.value)}
          autoComplete="username"
          autoFocus
          required
        />
        <TextInput
          label="Password"
          type="password"
          value={secret}
          onChange={(event) => setSecret(event.target.value)}
          autoComplete="current-password"
          required
        />
        <Button type="submit" size="lg" disabled={action.is_pending}>
          {action.is_pending ? 'Signing in…' : 'Sign in'}
        </Button>
      </form>
    </main>
  )
}
