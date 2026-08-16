import {
  planRoutes,
  type LatLng,
  type RoutePlan,
} from '../api/transit.ts'

export const TOKYO_STATION_DEMO_ORIGIN: LatLng = {
  lat: 35.6812,
  lng: 139.7671,
}

interface RouteOrigin extends LatLng {
  isDemo: boolean
}

type RoutePlanner = (from: LatLng, to: LatLng) => Promise<RoutePlan[]>

export interface RouteSearchResult {
  plans: RoutePlan[]
  isDemo: boolean
}

// Keep the first search and the review demo separate: a zero-result response
// can also happen inside Japan, so the caller must ask the user before using
// Tokyo Station instead of silently replacing their real origin.
export async function searchRoutesFromOrigin(
  origin: RouteOrigin,
  destination: LatLng,
  planner: RoutePlanner = planRoutes,
): Promise<RouteSearchResult> {
  const plans = await planner(origin, destination)
  return { plans, isDemo: origin.isDemo }
}

export async function searchDemoRoutes(
  destination: LatLng,
  planner: RoutePlanner = planRoutes,
): Promise<RouteSearchResult> {
  const plans = await planner(TOKYO_STATION_DEMO_ORIGIN, destination)
  return { plans, isDemo: true }
}
