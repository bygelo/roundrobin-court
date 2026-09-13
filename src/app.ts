// The court app: kernel + the OS packs a venue needs + this app's own modules.
//
// Note what this file does NOT contain: any tenancy code, any permission code,
// any double-booking logic. Those live in the OS. The sport-specific surface —
// rotation, score, sport profile, display, Studio, DUPR — lives in src/module/.

import { KERNEL_MODULE, createApp, type KernelApp, type ModuleDeclaration, type Store } from '@bygelo/roundrobin-kernel'
import { BILLING_MODULE, billingRoute } from '@bygelo/roundrobin-billing'
import { BOOKING_MODULE, bookingRoute } from '@bygelo/roundrobin-booking'
import { COMMERCE_MODULE, commerceRoute } from '@bygelo/roundrobin-commerce'
import { CONNECTOR_MODULE, connectorRoute } from '@bygelo/roundrobin-connector'
import { CONSENT_MODULE, consentRoute } from '@bygelo/roundrobin-consent'
import { MEMBERSHIP_MODULE, membershipRoute } from '@bygelo/roundrobin-membership'
import { NOTIFICATION_MODULE, notificationRoute } from '@bygelo/roundrobin-notification'
import { OUTPUT_MODULE, createOutputRoute } from '@bygelo/roundrobin-output'
import { SCAN_MODULE, createScanRoute } from '@bygelo/roundrobin-scan'
import { APP_MODULE, createAppRoute } from './module/index.ts'

export { COURT_MODULE, SPORT_CATEGORY } from './module/court/index.ts'

/** The OS packs this app composes. Each is removable; court's modules declare which they need. */
export const PACK_DECLARATION: ModuleDeclaration[] = [
  // The kernel's own API-key and export surfaces. Without this declaration no
  // session can ever hold kernel.api_key.manage or kernel.export.
  KERNEL_MODULE,
  BOOKING_MODULE,
  BILLING_MODULE,
  MEMBERSHIP_MODULE,
  COMMERCE_MODULE,
  NOTIFICATION_MODULE,
  CONNECTOR_MODULE,
  CONSENT_MODULE,
  OUTPUT_MODULE,
  SCAN_MODULE,
]

export const COURT_DECLARATION: ModuleDeclaration[] = [...PACK_DECLARATION, ...APP_MODULE]

export function createCourtApp(store: Store): KernelApp {
  return createApp({ store, declaration: COURT_DECLARATION }, [
    // App routes first: court's literal paths must never be shadowed by a pack
    // parameter route, and a pack never registers under /api/v1/<court module>.
    ...createAppRoute(store),
    bookingRoute,
    billingRoute,
    membershipRoute,
    commerceRoute,
    notificationRoute,
    connectorRoute,
    consentRoute,
    createOutputRoute(store),
    createScanRoute(store),
  ])
}
