// The operator session and what the server says this session may do.
//
// Discovery, not configuration: the nav shows a screen only when the tenant has
// its module enabled, because GET /api/v1/capability says so.

import { createContext, useContext } from 'react'
import type { OperatorSession } from './api.ts'

export type CapabilityModule = {
  module_code: string
  is_enabled: boolean
  schema_version: number
  route_prefix: string[]
}

export type Capability = {
  organization_id: string
  module: CapabilityModule[]
  capability: string[]
}

export type OperatorContext = {
  session: OperatorSession
  capability: Capability
  isEnabled: (module_code: string) => boolean
  can: (capability_code: string) => boolean
  /** Re-read capability after a module is toggled. */
  refreshCapability: () => void
  signOut: () => void
}

export const OperatorSessionContext = createContext<OperatorContext | undefined>(undefined)

export function useOperator(): OperatorContext {
  const value = useContext(OperatorSessionContext)
  if (!value) throw new Error('useOperator must be used inside the operator console')
  return value
}
