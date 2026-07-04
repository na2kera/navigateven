import type { Destination } from '../types.ts'

const STORAGE_KEY = 'navigateven_destinations'

export function getAllDestinations(): Destination[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter(
      (d): d is Destination =>
        typeof d?.id === 'string' &&
        typeof d?.name === 'string' &&
        typeof d?.lat === 'number' &&
        typeof d?.lng === 'number',
    )
  } catch {
    return []
  }
}

export function putDestination(dest: Destination): void {
  const all = getAllDestinations()
  const idx = all.findIndex(d => d.id === dest.id)
  if (idx >= 0) all[idx] = dest
  else all.push(dest)
  localStorage.setItem(STORAGE_KEY, JSON.stringify(all))
}

export function deleteDestination(id: string): void {
  const all = getAllDestinations().filter(d => d.id !== id)
  localStorage.setItem(STORAGE_KEY, JSON.stringify(all))
}

export function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}
