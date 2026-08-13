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

/** Icon shown at the head of a route step (issue #19). */
export type RouteIconKind = 'walk' | 'train' | 'bus'

// A display line of the route detail screen. `icon` is set only on the first
// line of a step; station/time lines and wrap continuations carry none, so
// the renderer can place at most one 20x20 icon per step.
export interface RouteDisplayLine {
  text: string
  icon?: RouteIconKind
}

export interface RoutePlan {
  departureSecs: number
  arrivalSecs: number
  durationSecs: number
  transferCount: number
  /** Transit leg labels in ride order (e.g. 山手線), for the candidate list row */
  routeNames: string[]
  lines: RouteDisplayLine[]
}

const ENDPOINT = 'https://api.transit.ls8h.com/api/v1/plan'
// Live measurement: the API can legitimately take 17s+ on heavy routes, so
// this must stay well above that. Users can double-tap out of the searching
// screen at any time.
const PLAN_TIMEOUT_MS = 30_000

// Journeys with absurd durations (e.g. arrival on the next day because the
// only remaining bus departs 19h later) do appear in real responses.
const MAX_SANE_DURATION_SECS = 6 * 3600

// Cap so the candidate list fits on one glasses screen (VISIBLE_ROWS = 5)
// without needing a scroll window.
const MAX_CANDIDATES = 4

export async function planRoutes(from: LatLng, to: LatLng): Promise<RoutePlan[]> {
  const params = new URLSearchParams({
    from: `geo:${from.lat},${from.lng}`,
    to: `geo:${to.lat},${to.lng}`,
  })
  const res = await fetchWithTimeout(`${ENDPOINT}?${params}`, PLAN_TIMEOUT_MS)
  if (!res.ok) throw new Error(`transit API error: ${res.status}`)
  const data: ApiPlanResponse = await res.json()

  return pickCandidateJourneys(data.journeys ?? []).map(toRoutePlan)
}

// The transit API's leg modes (GET /api/openapi.json, 2026-08 snapshot):
// tram, subway, rail, bus, ferry, cableTram, aerialLift, funicular,
// trolleybus, monorail, air.
const BUS_MODES = new Set(['bus', 'trolleybus'])
// Modes that are neither rail-ish nor bus-ish: showing a train icon for a
// ferry or a flight would be misinformation, so these get no icon at all.
const NON_RAIL_MODES = new Set(['ferry', 'air', 'aerialLift'])
// Fallback labels when the API sends no routeName; without this a ferry leg
// would be captioned 列車.
const MODE_FALLBACK_LABELS: Record<string, string> = {
  bus: 'バス',
  trolleybus: 'バス',
  ferry: 'フェリー',
  air: '航空便',
  aerialLift: 'ロープウェイ',
}

function legLabel(leg: ApiLeg): string {
  return leg.routeName ?? MODE_FALLBACK_LABELS[leg.mode ?? ''] ?? '列車'
}

function toRoutePlan(journey: ApiJourney): RoutePlan {
  return {
    departureSecs: journey.departureSecs,
    arrivalSecs: journey.arrivalSecs,
    durationSecs: journey.durationSecs,
    transferCount: journey.transferCount,
    routeNames: journey.legs.filter(l => l.kind === 'transit').map(legLabel),
    lines: formatJourney(journey),
  }
}

// The API does not guarantee any useful ordering: real responses put a
// 2-transfer bus route ahead of a direct train. Sort by arrival ourselves,
// drop duplicate journeys, and make sure the fewest-transfer option is in
// the list so the candidates aren't just one route at successive departures.
export function pickCandidateJourneys(journeys: ApiJourney[]): ApiJourney[] {
  const sane = journeys.filter(
    j =>
      j.arrivalSecs > j.departureSecs &&
      j.durationSecs > 0 &&
      j.durationSecs <= MAX_SANE_DURATION_SECS &&
      Array.isArray(j.legs) &&
      j.legs.length > 0,
  )
  const byArrival = [...sane].sort(
    (a, b) => a.arrivalSecs - b.arrivalSecs || a.durationSecs - b.durationSecs,
  )

  const seen = new Set<string>()
  const unique: ApiJourney[] = []
  for (const j of byArrival) {
    const sig = j.legs
      .map(l =>
        l.kind === 'walk' ? 'walk' : `${legLabel(l)}:${l.from.id}>${l.to.id}@${l.departureSecs}`,
      )
      .join('|')
    if (seen.has(sig)) continue
    seen.add(sig)
    unique.push(j)
  }

  const picked = unique.slice(0, MAX_CANDIDATES)
  const minTransfers = unique.reduce((m, j) => Math.min(m, j.transferCount), Infinity)
  if (picked.length > 0 && picked.every(j => j.transferCount > minTransfers)) {
    picked[picked.length - 1] = unique.find(j => j.transferCount === minTransfers)!
  }
  return picked
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

// Bus-ish modes get the bus icon, known non-rail modes (ferry/air/ropeway)
// get none, and everything else — the rail-ish modes plus missing or
// future unknown values — falls back to the train icon (issue #19).
function legIcon(leg: ApiLeg): RouteIconKind | undefined {
  if (leg.kind === 'walk') return 'walk'
  if (leg.mode !== undefined && BUS_MODES.has(leg.mode)) return 'bus'
  if (leg.mode !== undefined && NON_RAIL_MODES.has(leg.mode)) return undefined
  return 'train'
}

// accessWalkSecs / egressWalkSecs are NOT part of legs, so the walk from the
// current position to the first stop (and last stop to destination) must be
// added explicitly. Consecutive walks (e.g. station transfer walk followed by
// egress walk) are merged into a single step.
export function formatJourney(journey: ApiJourney): RouteDisplayLine[] {
  const lines: RouteDisplayLine[] = []
  const durationMin = Math.round(journey.durationSecs / 60)
  lines.push({
    text: `出発 ${secsToClock(journey.departureSecs)} → 到着 ${secsToClock(journey.arrivalSecs)}`,
  })
  lines.push({ text: `所要 ${durationMin}分 / 乗換 ${journey.transferCount}回` })
  lines.push({ text: '' })

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

  // Step numbers are replaced by mode icons (issue #19). The icons live in a
  // gutter LEFT of the route text container (the body font is proportional,
  // so space-indenting into a gutter would be font-dependent) — step lines
  // therefore start unindented, and station/time lines keep their relative
  // space indent.
  for (const step of steps) {
    if (step.kind === 'walk') {
      if (step.secs < 60) continue // skip negligible walks
      lines.push({ text: `徒歩 ${walkMinutes(step.secs)}分`, icon: 'walk' })
    } else {
      const { leg } = step
      const route = legLabel(leg)
      const headsign = leg.headsign ? ` ${leg.headsign}` : ''
      lines.push({ text: `${route}${headsign}`, icon: legIcon(leg) })
      lines.push({ text: `   ${leg.from.name} ${secsToClock(leg.departureSecs)}` })
      lines.push({ text: `   → ${leg.to.name} ${secsToClock(leg.arrivalSecs)}` })
    }
  }

  return lines
}
