import type { EvenAppBridge } from '@evenrealities/even_hub_sdk'
import type { Destination } from '../types.ts'

const STORAGE_KEY = 'navigateven_destinations'
// The storage bridge may never resolve on hosts that don't implement it —
// same failure mode as the location bridge — so every call gets a race.
const BRIDGE_STORAGE_TIMEOUT_MS = 3000

// Primary store is the HOST side (bridge.setLocalStorage): Private-Testing
// launches recreate the WebView, wiping window.localStorage, but host storage
// survives. window.localStorage is kept as fallback + migration source.
let bridge: EvenAppBridge | null = null
let cache: Destination[] = []

function parseDestinations(raw: string | null | undefined): Destination[] | null {
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return null
    return parsed.filter(
      (d): d is Destination =>
        typeof d?.id === 'string' &&
        typeof d?.name === 'string' &&
        typeof d?.lat === 'number' &&
        typeof d?.lng === 'number',
    )
  } catch {
    return null
  }
}

function withTimeout<T>(promise: Promise<T>, fallback: T): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>(resolve => setTimeout(() => resolve(fallback), BRIDGE_STORAGE_TIMEOUT_MS)),
  ])
}

function readWebViewStorage(): string | null {
  try {
    return localStorage.getItem(STORAGE_KEY)
  } catch {
    return null
  }
}

export async function initDestinationStore(evenBridge: EvenAppBridge): Promise<void> {
  bridge = evenBridge
  try {
    const raw = await withTimeout(evenBridge.getLocalStorage(STORAGE_KEY), '')
    const fromBridge = parseDestinations(raw)
    if (fromBridge) {
      cache = fromBridge
      return
    }
  } catch {
    // host storage unavailable — fall through to WebView storage
  }
  // No host-side data yet: adopt whatever the WebView storage has (data saved
  // by pre-bridge versions or simulator sessions) and migrate it up.
  cache = parseDestinations(readWebViewStorage()) ?? []
  if (cache.length > 0) persist()
}

function persist(): void {
  const json = JSON.stringify(cache)
  try {
    localStorage.setItem(STORAGE_KEY, json)
  } catch {
    // quota/unavailable — host storage below is the one that matters
  }
  if (bridge) {
    withTimeout(bridge.setLocalStorage(STORAGE_KEY, json), false).catch(err =>
      console.error('setLocalStorage failed', err),
    )
  }
}

export function getAllDestinations(): Destination[] {
  return [...cache]
}

export function putDestination(dest: Destination): void {
  const idx = cache.findIndex(d => d.id === dest.id)
  if (idx >= 0) cache[idx] = dest
  else cache.push(dest)
  persist()
}

export function deleteDestination(id: string): void {
  cache = cache.filter(d => d.id !== id)
  persist()
}

export function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}
