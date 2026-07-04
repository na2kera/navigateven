import { fetchWithTimeout } from './http.ts'

export interface GeocodeResult {
  name: string
  displayName: string
  lat: number
  lng: number
}

// Nominatim usage policy: identify heavy usage via the email param.
// User-Agent is a forbidden header in browser fetch, so this is our only knob.
// Leave empty to omit; set your contact address before publishing.
const CONTACT_EMAIL = ''

const GSI_ENDPOINT = 'https://msearch.gsi.go.jp/address-search/AddressSearch'
const NOMINATIM_ENDPOINT = 'https://nominatim.openstreetmap.org/search'

// GSI resolves Japanese street addresses down to block level (Nominatim
// finds almost none of them), but for facility names GSI returns unrelated
// place-name matches nationwide. So route by query shape and use the other
// source as fallback when the first returns nothing.
//
// Address shapes only — a bare digit is not enough, or facility names like
// 「◯◯タワー3階」 would route to GSI, get a coarse non-empty hit, and never
// reach Nominatim (which knows the actual facility).
function looksLikeAddress(query: string): boolean {
  return (
    /[0-9０-９]+\s*(丁目|番地?|号)/.test(query) ||
    /[0-9０-９]+[-−ー－][0-9０-９]+/.test(query) ||
    /^(東京都|北海道|京都府|大阪府|.{2,3}県)/.test(query)
  )
}

// Trailing floor/level qualifiers (「〜3階」「〜10F」) never help geocoding —
// they just turn an exact facility match into zero hits — so strip them
// before routing. Verified live: 「六本木ヒルズ森タワー3階」 misses on
// Nominatim while 「六本木ヒルズ森タワー」 hits the exact building.
function normalizeQuery(query: string): string {
  return query.replace(/\s*(地下|Ｂ|B)?[0-9０-９]+\s*(階|[FＦfｆ])$/, '').trim() || query
}

export async function searchPlaces(rawQuery: string): Promise<GeocodeResult[]> {
  const query = normalizeQuery(rawQuery)
  const sources = looksLikeAddress(query)
    ? [searchGsi, searchNominatim]
    : [searchNominatim, searchGsi]

  let anySourceSucceeded = false
  let lastError: unknown = null
  for (const search of sources) {
    try {
      const results = await search(query)
      anySourceSucceeded = true
      if (results.length > 0) return results
    } catch (err) {
      lastError = err
    }
  }
  // If at least one source answered (even with zero hits), "not found" is a
  // valid result — only surface a failure when every source failed, so the
  // UI doesn't show a connection error for a legitimately unknown place.
  if (!anySourceSucceeded && lastError) throw lastError
  return []
}

const SEARCH_TIMEOUT_MS = 10_000

async function searchGsi(query: string): Promise<GeocodeResult[]> {
  const res = await fetchWithTimeout(
    `${GSI_ENDPOINT}?q=${encodeURIComponent(query)}`,
    SEARCH_TIMEOUT_MS,
  )
  if (!res.ok) throw new Error(`GSI error: ${res.status}`)
  const data = await res.json()
  if (!Array.isArray(data)) return []

  return data
    .slice(0, 5)
    .map((item: any): GeocodeResult | null => {
      // GeoJSON order: [lng, lat]
      const lng = Number(item?.geometry?.coordinates?.[0])
      const lat = Number(item?.geometry?.coordinates?.[1])
      const title = String(item?.properties?.title ?? '')
      if (!Number.isFinite(lat) || !Number.isFinite(lng) || !title) return null
      return { name: title, displayName: title, lat, lng }
    })
    .filter((r): r is GeocodeResult => r !== null)
}

async function searchNominatim(query: string): Promise<GeocodeResult[]> {
  const params = new URLSearchParams({
    q: query,
    format: 'jsonv2',
    limit: '5',
    'accept-language': 'ja',
  })
  if (CONTACT_EMAIL) params.set('email', CONTACT_EMAIL)

  const res = await fetchWithTimeout(`${NOMINATIM_ENDPOINT}?${params}`, SEARCH_TIMEOUT_MS)
  if (!res.ok) throw new Error(`Nominatim error: ${res.status}`)
  const data = await res.json()
  if (!Array.isArray(data)) return []

  return data
    .map((item: any): GeocodeResult | null => {
      const lat = Number(item?.lat)
      const lng = Number(item?.lon)
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null
      return {
        name: String(item?.name || item?.display_name || query),
        displayName: String(item?.display_name ?? ''),
        lat,
        lng,
      }
    })
    .filter((r): r is GeocodeResult => r !== null)
}
