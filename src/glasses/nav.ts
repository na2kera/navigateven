import {
  type EvenAppBridge,
  type AppLocation,
  type TextContainerProperty,
  AppLocationAccuracy,
  CreateStartUpPageContainer,
  RebuildPageContainer,
  OsEventTypeList,
} from '@evenrealities/even_hub_sdk'
import type { Destination } from '../types.ts'
import { getAllDestinations } from '../store/destinations.ts'
import { planRoute } from '../api/transit.ts'
import {
  CONTAINER_TOTAL,
  VISIBLE_ROWS,
  buildListScreen,
  buildRouteScreen,
  buildMessageScreen,
  wrapLines,
  routePageCount,
} from './layout.ts'

// Which glasses screen is showing, as a tagged union so each screen only
// carries the fields that are valid for it.
type Screen =
  | { kind: 'list' }
  | { kind: 'searching'; dest: Destination }
  | { kind: 'route'; dest: Destination; lines: string[]; page: number; isDemo: boolean }
  | { kind: 'error'; dest: Destination; message: string }

// Fallback when the host returns no position (the simulator does not
// implement the location bridge at all). Tokyo Station.
const DEMO_LOCATION = { lat: 35.6812, lng: 139.7671 }
const LOCATION_TIMEOUT_MS = 8000

let bridge: EvenAppBridge | null = null
let screen: Screen = { kind: 'list' }
// List context lives outside Screen so the selection survives visiting other
// screens and coming back.
let destinations: Destination[] = []
let selectedIndex = 0
let scrollOffset = 0
let searchToken = 0

export async function initGlasses(evenBridge: EvenAppBridge): Promise<void> {
  bridge = evenBridge
  destinations = getAllDestinations()
  await bridge.createStartUpPageContainer(
    new CreateStartUpPageContainer({
      containerTotalNum: CONTAINER_TOTAL,
      textObject: buildScreen(),
      imageObject: [],
    }),
  )
}

// Called by the phone UI after add/edit/delete so the glasses list stays fresh.
export async function refreshDestinations(): Promise<void> {
  // Follow the selected destination by id, not by position — deleting an
  // entry above it must not silently re-point the selection elsewhere.
  const selectedId = destinations[selectedIndex]?.id
  destinations = getAllDestinations()
  const followed = selectedId ? destinations.findIndex(d => d.id === selectedId) : -1
  selectedIndex = followed >= 0
    ? followed
    : Math.max(0, Math.min(selectedIndex, destinations.length - 1))
  // Keep the selection inside the visible window
  scrollOffset = Math.min(scrollOffset, Math.max(0, destinations.length - VISIBLE_ROWS))
  if (selectedIndex < scrollOffset) scrollOffset = selectedIndex
  if (selectedIndex >= scrollOffset + VISIBLE_ROWS) scrollOffset = selectedIndex - VISIBLE_ROWS + 1
  if (screen.kind === 'list') render()
}

// The exhaustive switch (no default, must return) makes the compiler reject a
// new Screen kind until it renders something.
function buildScreen(): TextContainerProperty[] {
  switch (screen.kind) {
    case 'list':
      return buildListScreen(destinations, selectedIndex, scrollOffset)
    case 'searching':
      return buildMessageScreen(`→ ${screen.dest.name}`, '経路を検索中...', '2回タップ: 戻る')
    case 'route':
      return buildRouteScreen(screen.dest.name, screen.lines, screen.page, screen.isDemo)
    case 'error':
      return buildMessageScreen(`→ ${screen.dest.name}`, screen.message, 'タップ:再試行  2回:戻る')
  }
}

// Rebuilds are serialized: while one is in flight, further render() calls
// only mark the state dirty, and the latest state is pushed once the current
// write finishes. This prevents overlapping BLE writes from applying out of
// order (a stale screen overwriting a newer one) and keeps rapid scrolling
// from queueing a rebuild per tick.
let renderInFlight = false
let renderDirty = false

function render(): void {
  if (renderInFlight) {
    renderDirty = true
    return
  }
  void renderLoop()
}

async function renderLoop(): Promise<void> {
  if (!bridge) return
  renderInFlight = true
  try {
    do {
      renderDirty = false
      try {
        await bridge.rebuildPageContainer(
          new RebuildPageContainer({
            containerTotalNum: CONTAINER_TOTAL,
            textObject: buildScreen(),
            imageObject: [],
          }),
        )
      } catch (err) {
        console.error('rebuildPageContainer failed', err)
      }
    } while (renderDirty)
  } finally {
    renderInFlight = false
  }
}

// getAppLocation may never resolve on hosts without location support, so we
// race it against our own timeout rather than trusting options.timeoutMs.
async function getCurrentLocation(): Promise<{ lat: number; lng: number; isDemo: boolean }> {
  if (!bridge) return { ...DEMO_LOCATION, isDemo: true }
  try {
    const location = await Promise.race<AppLocation | null>([
      bridge.getAppLocation({
        accuracy: AppLocationAccuracy.Medium,
        timeoutMs: LOCATION_TIMEOUT_MS,
      }),
      new Promise<null>(resolve => setTimeout(() => resolve(null), LOCATION_TIMEOUT_MS)),
    ])
    if (location && Number.isFinite(location.latitude) && Number.isFinite(location.longitude)) {
      return { lat: location.latitude, lng: location.longitude, isDemo: false }
    }
  } catch {
    // fall through to demo location
  }
  return { ...DEMO_LOCATION, isDemo: true }
}

async function startSearch(dest: Destination): Promise<void> {
  const token = ++searchToken
  screen = { kind: 'searching', dest }
  render()

  try {
    const origin = await getCurrentLocation()
    if (token !== searchToken) return
    const plan = await planRoute(origin, dest)
    if (token !== searchToken) return

    if (!plan) {
      screen = { kind: 'error', dest, message: '経路が見つかりませんでした' }
    } else {
      screen = {
        kind: 'route',
        dest,
        lines: wrapLines(plan.lines),
        page: 0,
        isDemo: origin.isDemo,
      }
    }
    render()
  } catch {
    if (token !== searchToken) return
    screen = { kind: 'error', dest, message: '経路検索に失敗しました\n通信状態を確認してください' }
    render()
  }
}

function backToList(): void {
  searchToken++ // invalidate any in-flight search
  screen = { kind: 'list' }
  render()
}

// Event handling — call this from onEvenHubEvent
export function handleInput(eventType: OsEventTypeList): void {
  switch (screen.kind) {
    case 'list':
      handleList(eventType)
      break
    case 'searching':
      if (eventType === OsEventTypeList.DOUBLE_CLICK_EVENT) backToList()
      break
    case 'route':
      handleRoute(screen, eventType)
      break
    case 'error':
      handleError(screen, eventType)
      break
  }
}

// Gesture mapping (issue #15): on-device, SCROLL_BOTTOM is the gesture users
// read as "go down / next" and SCROLL_TOP as "go up / previous" — the
// opposite of the initial assignment.
function handleList(eventType: OsEventTypeList): void {
  if (eventType === OsEventTypeList.SCROLL_BOTTOM_EVENT) {
    if (selectedIndex < destinations.length - 1) {
      selectedIndex++
      if (selectedIndex >= scrollOffset + VISIBLE_ROWS) scrollOffset++
      render()
    }
  } else if (eventType === OsEventTypeList.SCROLL_TOP_EVENT) {
    if (selectedIndex > 0) {
      selectedIndex--
      if (selectedIndex < scrollOffset) scrollOffset--
      render()
    }
  } else if (eventType === OsEventTypeList.CLICK_EVENT) {
    const dest = destinations[selectedIndex]
    if (dest) startSearch(dest)
  } else if (eventType === OsEventTypeList.DOUBLE_CLICK_EVENT) {
    bridge?.shutDownPageContainer(1)
  }
}

function handleRoute(
  current: Extract<Screen, { kind: 'route' }>,
  eventType: OsEventTypeList,
): void {
  if (eventType === OsEventTypeList.SCROLL_BOTTOM_EVENT) {
    if (current.page < routePageCount(current.lines) - 1) {
      screen = { ...current, page: current.page + 1 }
      render()
    }
  } else if (eventType === OsEventTypeList.SCROLL_TOP_EVENT) {
    if (current.page > 0) {
      screen = { ...current, page: current.page - 1 }
      render()
    }
  } else if (eventType === OsEventTypeList.CLICK_EVENT) {
    startSearch(current.dest) // re-search from fresh position
  } else if (eventType === OsEventTypeList.DOUBLE_CLICK_EVENT) {
    backToList()
  }
}

function handleError(
  current: Extract<Screen, { kind: 'error' }>,
  eventType: OsEventTypeList,
): void {
  if (eventType === OsEventTypeList.CLICK_EVENT) {
    startSearch(current.dest)
  } else if (eventType === OsEventTypeList.DOUBLE_CLICK_EVENT) {
    backToList()
  }
}
