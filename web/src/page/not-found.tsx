import { ButtonLink, EmptyState } from '../component/ui.tsx'

export default function NotFound() {
  return (
    <div className="not-found">
      <EmptyState
        title="That page is not here"
        description="The link may be old, or the venue may have turned this feature off."
        action={<ButtonLink to="/">Go to the venue</ButtonLink>}
      />
    </div>
  )
}
