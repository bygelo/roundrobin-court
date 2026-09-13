// Response shapes of /api/v1/court/* as the browser receives them (instants are ISO strings).

export type Site = {
  site_id: string
  site_code: string
  display_name: string
  address_line: string | null
  time_zone: string
  contact_phone_number: string | null
  contact_email_address: string | null
}

export type VenueOverview = {
  site: Site | null
  checklist: {
    has_site: boolean
    has_sport: boolean
    has_court: boolean
    has_operating_hour: boolean
    has_schedule: boolean
  }
  court_count: number
  schedule_count: number
}

export type Court = {
  resource_id: string
  resource_code: string
  display_name: string
  sort_order: number
  capacity_count: number | null
  sport_code: string | null
  sport_display_name: string | null
  is_retired: boolean
  upcoming_booking_count: number
}

export type OperatingHour = { weekday_number: number; opens_local: string; closes_local: string }

export type Closure = {
  closure_id: string
  resource_id: string | null
  court_display_name: string | null
  reason: string
  starts_at: string
  ends_at: string
  is_site_wide: boolean
}

export type PeakWindow = { weekday_number: number; starts_local: string; ends_local: string }

export type Schedule = {
  court_schedule_id: string
  resource_category_id: string
  sport_code: string
  sport_display_name: string
  display_name: string
  slot_minute_count: number
  capacity_count: number
  off_peak_price_amount: string
  peak_price_amount: string
  horizon_day_count: number
  revision_number: number
  generated_at: string | null
  peak: PeakWindow[]
  court_count: number
  template_count: number
  upcoming_session_count: number
}

export type RegenerateResult = {
  template_count: number
  created_session_count: number
  retired_session_count: number
  kept_booked_session_count: number
}

export type Sport = {
  sport_profile_id: string
  sport_profile_code: string
  display_name: string
  team_size_count: number
  scoring_rule_code: string
  rating_provider_code: string | null
  session_minute_count: number
  court_count: number
}

export type SportCatalog = {
  sport: Sport[]
  scoring_rule: { scoring_rule_code: string; display_name: string }[]
  rating_provider: { rating_provider_code: string; display_name: string }[]
}

export type BookingPolicy = {
  advance_window_day_count: number
  cancellation_cutoff_hour_count: number
  hold_minute_count: number
  is_guest_booking_allowed: boolean
}

export type BoardBooking = {
  booking_id: string
  booking_code: string
  status: 'hold' | 'confirmed' | string
  starts_at: string
  ends_at: string
  price_amount: string
  hold_expire_at: string | null
  session_id: string
  resource_id: string
  session_type: string
  participant_count: number
  party_display_name: string | null
  party_phone_number: string | null
  paid_state: 'paid' | 'partial' | 'unpaid' | null
  channel_code: string | null
}

export type BoardSession = {
  session_id: string
  display_name: string | null
  starts_at: string
  ends_at: string
  price_amount: string
  session_type: string
  is_bookable: boolean
}

export type BoardCourt = {
  resource_id: string
  resource_code: string
  display_name: string
  sort_order: number
  capacity_count: number | null
  sport_code: string | null
  sport_display_name: string | null
  session: BoardSession[]
  booking: BoardBooking[]
  closure: Closure[]
}

export type Board = {
  date: string
  time_zone: string
  site_display_name: string | null
  day_starts_at: string
  day_ends_at: string
  opens_local: string | null
  closes_local: string | null
  court: BoardCourt[]
  closure: Closure[]
}

export type VenueTabCode = 'venue' | 'court' | 'hour' | 'schedule' | 'sport' | 'policy'

export type TabProp = {
  is_manager: boolean
  /** Something the setup checklist counts has changed. */
  onChange: () => void
  onGo: (tab: VenueTabCode) => void
}
