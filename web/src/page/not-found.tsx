import { ButtonLink, EmptyState } from '../component/ui.tsx'
import { usePath } from '../route.tsx'

export default function NotFound() {
  // Inside the operator console the shell already provides <main>; elsewhere this page is the whole screen.
  const is_inside_shell = usePath().startsWith('/operator/')
  const content = (
    <>
      <h1 className="visually-hidden">Page not found</h1>
      <EmptyState
        title="That page is not here"
        description="The link may be old, or the venue may have turned this feature off."
        action={<ButtonLink to="/">Go to the venue</ButtonLink>}
      />
    </>
  )
  return is_inside_shell ? (
    <div className="not-found">{content}</div>
  ) : (
    <main className="not-found" id="main">
      {content}
    </main>
  )
}
