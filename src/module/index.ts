// Every module this app owns, in one list.
//
// Pre-registered by the foundation checkpoint so parallel lanes never edit a
// shared file: each lane fills in src/module/<code>/ and this list already
// imports it. Order is the order routes register — a module whose literal
// paths could be swallowed by another's parameter route must come first.

import type { ModuleDeclaration, RouteContributor, Store } from '@bygelo/roundrobin-kernel'
import { ADMIN_MODULE, createAdminRoute } from './admin/index.ts'
import { ARRIVAL_MODULE, createArrivalRoute } from './arrival/index.ts'
import { CALENDAR_MODULE, createCalendarRoute } from './calendar/index.ts'
import { COURT_MODULE, createCourtRoute } from './court/index.ts'
import { DISPLAY_MODULE, createDisplayRoute } from './display/index.ts'
import { DUPR_MODULE, createDuprRoute } from './dupr/index.ts'
import { INSIGHT_MODULE, createInsightRoute } from './insight/index.ts'
import { MEMBER_MODULE, createMemberRoute } from './member/index.ts'
import { MESSAGE_MODULE, createMessageRoute } from './message/index.ts'
import { PLAY_MODULE, createPlayRoute } from './play/index.ts'
import { PORTAL_MODULE, createPortalRoute } from './portal/index.ts'
import { PROGRAM_MODULE, createProgramRoute } from './program/index.ts'
import { SCORE_MODULE, createScoreRoute } from './score/index.ts'
import { SHOP_MODULE, createShopRoute } from './shop/index.ts'
import { STUDIO_MODULE, createStudioRoute } from './studio/index.ts'
import { WEBHOOK_MODULE, createWebhookRoute } from './webhook/index.ts'

export const APP_MODULE: ModuleDeclaration[] = [
  COURT_MODULE,
  PORTAL_MODULE,
  PLAY_MODULE,
  PROGRAM_MODULE,
  ARRIVAL_MODULE,
  SCORE_MODULE,
  DISPLAY_MODULE,
  STUDIO_MODULE,
  SHOP_MODULE,
  MEMBER_MODULE,
  INSIGHT_MODULE,
  DUPR_MODULE,
  WEBHOOK_MODULE,
  CALENDAR_MODULE,
  MESSAGE_MODULE,
  ADMIN_MODULE,
]

export function createAppRoute(store: Store): RouteContributor[] {
  return [
    createCourtRoute(store),
    createPortalRoute(store),
    createPlayRoute(store),
    createProgramRoute(store),
    createArrivalRoute(store),
    createScoreRoute(store),
    createDisplayRoute(store),
    createStudioRoute(store),
    createShopRoute(store),
    createMemberRoute(store),
    createInsightRoute(store),
    createDuprRoute(store),
    createWebhookRoute(store),
    createCalendarRoute(store),
    createMessageRoute(store),
    createAdminRoute(store),
  ]
}
