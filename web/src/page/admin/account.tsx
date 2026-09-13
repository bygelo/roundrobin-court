// STUB written by the lead. Owned by the admin lane: a staff member's own account.

import { EmptyState, PageHeader } from '../../component/ui.tsx'
import type { PageProp } from '../../registry.ts'

export default function Page(_prop: PageProp) {
  return (
    <>
      <PageHeader title="Your account" />
      <EmptyState title="Not built yet" description="Change your own password here." />
    </>
  )
}
