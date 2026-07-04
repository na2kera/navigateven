import { fetchWithTimeout } from './http.ts'

export interface LatLng {
  lat: number
  lng: number
}

interface ApiPlace {
  id: string
  name: string
}

interface ApiLeg {
  kind: 'transit' | 'walk'
  routeName?: string
  mode?: string
  headsign?: string
  from: ApiPlace
  to: ApiPlace
  departureSecs: number
  arrivalSecs: number
}

interface ApiJourney {
  departureSecs: number
  arrivalSecs: number
  durationSecs: number
  transferCount: number
  legs: ApiLeg[]
  accessWalkSecs?: number
  egressWalkSecs?: number
}

interface ApiPlanResponse {
  journeys?: ApiJourney[]
}

export interface RoutePlan {
  departureSecs: number
  arrivalSecs: number
  durationSecs: number
  transferCount: number
  lines: string[]
}

const ENDPOINT = 'https://api.transit.ls8h.com/api/v1/plan'
// Live measurement: the API can legitimately take 17s+ on heavy routes, so
// this must stay well above that. Users can double-tap out of the searching
// screen at any time.
const PLAN_TIMEOUT_MS = 30_000

// Journeys with absurd durations (e.g. arrival on the next day because the
// only remaining bus departs 19h later) do appear in real responses.
const MAX_SANE_DURATION_SECS = 6 * 3600

export async function planRoute(from: LatLng, to: LatLng): Promise<RoutePlan | null> {
  const params = new URLSearchParams({
    from: `geo:${from.lat},${from.lng}`,
    to: `geo:${to.lat},${to.lng}`,
  })
  const res = await fetchWithTimeout(`${ENDPOINT}?${params}`, PLAN_TIMEOUT_MS)
  if (!res.ok) throw new Error(`transit API error: ${res.status}`)
  const data: ApiPlanResponse = await res.json()

  const journey = pickBestJourney(data.journeys ?? [])
  if (!journey) return null

  return {
    departureSecs: journey.departureSecs,
    arrivalSecs: journey.arrivalSecs,
    durationSecs: journey.durationSecs,
    transferCount: journey.transferCount,
    lines: formatJourney(journey),
  }
}

// The API does not guarantee the first journey is the best one: real
// responses put a 2-transfer bus route ahead of a direct train. Pick the
// earliest sane arrival ourselves.
export function pickBestJourney(journeys: ApiJourney[]): ApiJourney | null {
  const sane = journeys.filter(
    j =>
      j.arrivalSecs > j.departureSecs &&
      j.durationSecs > 0 &&
      j.durationSecs <= MAX_SANE_DURATION_SECS &&
      Array.isArray(j.legs) &&
      j.legs.length > 0,
  )
  if (sane.length === 0) return null
  return sane.reduce((best, j) => (j.arrivalSecs < best.arrivalSecs ? j : best))
}

export function secsToClock(secs: number): string {
  const dayOffset = Math.floor(secs / 86400)
  const s = secs % 86400
  const hh = String(Math.floor(s / 3600)).padStart(2, '0')
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, '0')
  return dayOffset > 0 ? `翌${hh}:${mm}` : `${hh}:${mm}`
}

function walkMinutes(secs: number): number {
  return Math.max(1, Math.round(secs / 60))
}

// accessWalkSecs / egressWalkSecs are NOT part of legs, so the walk from the
// current position to the first stop (and last stop to destination) must be
// added explicitly. Consecutive walks (e.g. station transfer walk followed by
// egress walk) are merged into a single step.
export function formatJourney(journey: ApiJourney): string[] {
  const lines: string[] = []
  const durationMin = Math.round(journey.durationSecs / 60)
  lines.push(
    `出発 ${secsToClock(journey.departureSecs)} → 到着 ${secsToClock(journey.arrivalSecs)}`,
  )
  lines.push(`所要 ${durationMin}分 / 乗換 ${journey.transferCount}回`)
  lines.push('')

  type Step =
    | { kind: 'walk'; secs: number }
    | { kind: 'transit'; leg: ApiLeg }

  const steps: Step[] = []
  const pushWalk = (secs: number) => {
    const last = steps[steps.length - 1]
    if (last?.kind === 'walk') last.secs += secs
    else steps.push({ kind: 'walk', secs })
  }

  if ((journey.accessWalkSecs ?? 0) > 0) pushWalk(journey.accessWalkSecs!)
  for (const leg of journey.legs) {
    if (leg.kind === 'walk') pushWalk(leg.arrivalSecs - leg.departureSecs)
    else steps.push({ kind: 'transit', leg })
  }
  if ((journey.egressWalkSecs ?? 0) > 0) pushWalk(journey.egressWalkSecs!)

  let stepNo = 1
  for (const step of steps) {
    if (step.kind === 'walk') {
      if (step.secs < 60) continue // skip negligible walks
      lines.push(`${stepNo}. 徒歩 ${walkMinutes(step.secs)}分`)
    } else {
      const { leg } = step
      const route = leg.routeName ?? (leg.mode === 'bus' ? 'バス' : '列車')
      const headsign = leg.headsign ? ` ${leg.headsign}` : ''
      lines.push(`${stepNo}. ${route}${headsign}`)
      lines.push(`   ${leg.from.name} ${secsToClock(leg.departureSecs)}`)
      lines.push(`   → ${leg.to.name} ${secsToClock(leg.arrivalSecs)}`)
    }
    stepNo++
  }

  return lines
}
