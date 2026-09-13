// Program kind vocabulary shared by the operator and public program screens.

import type { BadgeTone } from '../../component/ui.tsx'

export type ProgramKind = 'clinic' | 'lesson' | 'social' | 'league' | 'tournament' | 'private_event'

export const KIND_LABEL: Record<ProgramKind, string> = {
  clinic: 'Clinic',
  lesson: 'Lesson',
  social: 'Social',
  league: 'League',
  tournament: 'Tournament',
  private_event: 'Private event',
}

export const KIND_TONE: Record<ProgramKind, BadgeTone> = {
  clinic: 'info',
  lesson: 'info',
  social: 'success',
  league: 'neutral',
  tournament: 'neutral',
  private_event: 'caution',
}
