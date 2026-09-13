// Every screen in the app, pre-registered by the foundation checkpoint so lanes
// never edit this file. A lane fills in its own page files.
//
// surface:
//   operator — inside the staff console; needs a session; nav entry shown only
//              when module_code is enabled for the tenant.
//   public   — inside the branded venue site; no session.
//   bare     — full screen, no chrome (display TVs).

import { lazy, type ComponentType, type LazyExoticComponent } from 'react'

export type PageProp = { param: Record<string, string> }

export type NavGroup = 'Today' | 'Play' | 'Business' | 'Venue' | 'Connect' | 'Admin'

export type PageEntry = {
  pattern: string
  surface: 'operator' | 'public' | 'bare'
  title: string
  module_code?: string
  group?: NavGroup
  icon?: string
  component: LazyExoticComponent<ComponentType<PageProp>>
}

export const PAGE: PageEntry[] = [
  // ---- operator console --------------------------------------------------
  { pattern: '/operator/board', surface: 'operator', title: 'Court board', module_code: 'court', group: 'Today', icon: 'board', component: lazy(() => import('./page/court/board.tsx')) },
  { pattern: '/operator/booking', surface: 'operator', title: 'Bookings', module_code: 'portal', group: 'Today', icon: 'booking', component: lazy(() => import('./page/portal/booking.tsx')) },
  { pattern: '/operator/arrival', surface: 'operator', title: 'Arrival', module_code: 'arrival', group: 'Today', icon: 'arrival', component: lazy(() => import('./page/arrival/operator.tsx')) },
  { pattern: '/operator/play', surface: 'operator', title: 'Open play', module_code: 'play', group: 'Play', icon: 'play', component: lazy(() => import('./page/play/operator.tsx')) },
  { pattern: '/operator/program', surface: 'operator', title: 'Programs', module_code: 'program', group: 'Play', icon: 'program', component: lazy(() => import('./page/program/operator.tsx')) },
  { pattern: '/operator/score', surface: 'operator', title: 'Scoring', module_code: 'score', group: 'Play', icon: 'score', component: lazy(() => import('./page/score/operator.tsx')) },
  { pattern: '/operator/display', surface: 'operator', title: 'Displays', module_code: 'display', group: 'Play', icon: 'display', component: lazy(() => import('./page/display/operator.tsx')) },
  { pattern: '/operator/shop', surface: 'operator', title: 'Shop', module_code: 'shop', group: 'Business', icon: 'shop', component: lazy(() => import('./page/shop/operator.tsx')) },
  { pattern: '/operator/member', surface: 'operator', title: 'Membership', module_code: 'member', group: 'Business', icon: 'member', component: lazy(() => import('./page/member/operator.tsx')) },
  { pattern: '/operator/insight', surface: 'operator', title: 'Insight', module_code: 'insight', group: 'Business', icon: 'insight', component: lazy(() => import('./page/insight/operator.tsx')) },
  { pattern: '/operator/venue', surface: 'operator', title: 'Venue setup', module_code: 'court', group: 'Venue', icon: 'venue', component: lazy(() => import('./page/court/venue.tsx')) },
  { pattern: '/operator/studio', surface: 'operator', title: 'Studio', module_code: 'studio', group: 'Venue', icon: 'studio', component: lazy(() => import('./page/studio/operator.tsx')) },
  { pattern: '/operator/message', surface: 'operator', title: 'Player messages', module_code: 'message', group: 'Connect', icon: 'message', component: lazy(() => import('./page/message/operator.tsx')) },
  { pattern: '/operator/connect', surface: 'operator', title: 'Connections', module_code: 'webhook', group: 'Connect', icon: 'connect', component: lazy(() => import('./page/connect/operator.tsx')) },
  { pattern: '/operator/staff', surface: 'operator', title: 'Staff', module_code: 'admin', group: 'Admin', icon: 'staff', component: lazy(() => import('./page/admin/staff.tsx')) },
  { pattern: '/operator/module', surface: 'operator', title: 'Modules', module_code: 'admin', group: 'Admin', icon: 'module', component: lazy(() => import('./page/admin/module.tsx')) },
  { pattern: '/operator/developer', surface: 'operator', title: 'API and keys', module_code: 'admin', group: 'Admin', icon: 'developer', component: lazy(() => import('./page/admin/developer.tsx')) },
  { pattern: '/operator/data', surface: 'operator', title: 'Venue data', module_code: 'admin', group: 'Admin', icon: 'data', component: lazy(() => import('./page/admin/data.tsx')) },
  // Every signed-in staff member, whatever their role: no module gate and no nav group
  // (the console footer links it), so a scorer can change their own password.
  { pattern: '/operator/account', surface: 'operator', title: 'Your account', component: lazy(() => import('./page/admin/account.tsx')) },

  // ---- public venue site -------------------------------------------------
  { pattern: '/v/:organization_code', surface: 'public', title: 'Book a court', module_code: 'portal', component: lazy(() => import('./page/portal/home.tsx')) },
  { pattern: '/v/:organization_code/booking/:booking_code', surface: 'public', title: 'Your booking', module_code: 'portal', component: lazy(() => import('./page/portal/recovery.tsx')) },
  { pattern: '/v/:organization_code/program', surface: 'public', title: 'Programs', module_code: 'program', component: lazy(() => import('./page/program/public.tsx')) },
  { pattern: '/v/:organization_code/shop', surface: 'public', title: 'Shop', module_code: 'shop', component: lazy(() => import('./page/shop/public.tsx')) },
  { pattern: '/v/:organization_code/privacy', surface: 'public', title: 'Your data', module_code: 'admin', component: lazy(() => import('./page/admin/privacy.tsx')) },
  { pattern: '/play/:token', surface: 'bare', title: 'Live open play', module_code: 'play', component: lazy(() => import('./page/play/live.tsx')) },

  // ---- bare ----------------------------------------------------------------
  { pattern: '/display', surface: 'bare', title: 'Display', module_code: 'display', component: lazy(() => import('./page/display/device.tsx')) },
]
