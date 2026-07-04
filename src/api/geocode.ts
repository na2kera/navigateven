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
function looksLikeAddress(query: string): boolean {
  return (
    /[0-9０-９]|丁目|番地|号/.test(query) ||
    /^(東京都|北海道|京都府|大阪府|.{2,3}県)/.test(query)
  )
}

export async function searchPlaces(query: string): Promise<GeocodeResult[]> {
  const sources = looksLikeAddress(query)
    ? [searchGsi, searchNominatim]
    : [searchNominatim, searchGsi]

  let lastError: unknown = null
  for (const search of sources) {
    try {
      const results = await search(query)
      if (results.length > 0) return results
    } catch (err) {
      lastError = err
    }
  }
  // Both empty → no hits; but if a source failed and the other was empty,
  // surface the failure so the UI shows "check your connection".
  if (lastError) throw lastError
  return []
}

async function searchGsi(query: string): Promise<GeocodeResult[]> {
  const res = await fetch(`${GSI_ENDPOINT}?q=${encodeURIComponent(query)}`)
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

  const res = await fetch(`${NOMINATIM_ENDPOINT}?${params}`)
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
