import {
  type EvenAppBridge,
  type AppLocation,
  type TextContainerProperty,
  type ImageContainerProperty,
  AppLocationAccuracy,
  CreateStartUpPageContainer,
  RebuildPageContainer,
  ImageRawDataUpdate,
  ImageRawDataUpdateResult,
  OsEventTypeList,
} from '@evenrealities/even_hub_sdk'
import type { Destination } from '../types.ts'
import { getAllDestinations } from '../store/destinations.ts'
import {
  type RoutePlan,
  type RouteDisplayLine,
  type RouteIconKind,
} from '../api/transit.ts'
import {
  searchRoutesFromOrigin,
  searchDemoRoutes,
  TOKYO_STATION_DEMO_ORIGIN,
} from './route-search.ts'
import {
  CONTAINER_TOTAL,
  VISIBLE_ROWS,
  buildListScreen,
  buildCandidatesScreen,
  buildRouteScreen,
  buildMessageScreen,
  buildUnsupportedRegionScreen,
  buildRouteIcons,
  hiddenIconContainers,
  wrapLines,
  maxRouteLineOffset,
  ROUTE_SCROLL_STEP,
  type IconPush,
} from './layout.ts'

// Which glasses screen is showing, as a tagged union so each screen only
// carries the fields that are valid for it. The route detail keeps the full
// candidate list so double-tap can return to it without re-searching.
type Screen =
  | { kind: 'list' }
  | { kind: 'searching'; dest: Destination; message: string }
  | { kind: 'unsupported'; dest: Destination }
  | {
      kind: 'candidates'
      dest: Destination
      plans: RoutePlan[]
      selectedIndex: number
      isDemo: boolean
    }
  | {
      kind: 'route'
      dest: Destination
      plans: RoutePlan[]
      planIndex: number
      lines: RouteDisplayLine[]
      lineOffset: number
      isDemo: boolean
    }
  | { kind: 'error'; dest: Destination; message: string }

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
  const payload = buildScreen()
  await bridge.createStartUpPageContainer(
    new CreateStartUpPageContainer({
      containerTotalNum: CONTAINER_TOTAL,
      textObject: payload.textObject,
      imageObject: payload.imageObject,
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

interface ScreenPayload {
  textObject: TextContainerProperty[]
  imageObject: ImageContainerProperty[]
  /** Icon raw-data pushes to run serially after the rebuild (route only) */
  iconPushes: IconPush[]
}

function textOnly(textObject: TextContainerProperty[]): ScreenPayload {
  return { textObject, imageObject: hiddenIconContainers(), iconPushes: [] }
}

// The exhaustive switch (no default, must return) makes the compiler reject a
// new Screen kind until it renders something.
function buildScreen(): ScreenPayload {
  switch (screen.kind) {
    case 'list':
      return textOnly(buildListScreen(destinations, selectedIndex, scrollOffset))
    case 'searching':
      return textOnly(
        buildMessageScreen(`→ ${screen.dest.name}`, screen.message, '2回タップ: 戻る'),
      )
    case 'unsupported':
      return textOnly(buildUnsupportedRegionScreen(screen.dest.name))
    case 'candidates':
      return textOnly(buildCandidatesScreen(
        screen.dest.name,
        screen.plans,
        screen.selectedIndex,
        screen.isDemo,
      ))
    case 'route': {
      const { imageObject, pushes } = buildRouteIcons(screen.lines, screen.lineOffset)
      return {
        textObject: buildRouteScreen(screen.dest.name, screen.lines, screen.lineOffset, screen.isDemo),
        imageObject,
        iconPushes: pushes,
      }
    }
    case 'error':
      return textOnly(
        buildMessageScreen(`→ ${screen.dest.name}`, screen.message, 'タップ:再試行  2回:戻る'),
      )
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

// A failed rebuild leaves the glasses on the PREVIOUS screen while `screen`
// already points at the new one, so input would be handled against a state
// the user cannot see. Retry a few times (BLE hiccups are transient) before
// giving up until the next render() call.
const REBUILD_MAX_RETRIES = 2
const REBUILD_RETRY_DELAY_MS = 500

async function renderLoop(): Promise<void> {
  if (!bridge) return
  renderInFlight = true
  let retriesLeft = REBUILD_MAX_RETRIES
  try {
    do {
      renderDirty = false
      const payload = buildScreen()
      let rebuilt: boolean
      try {
        const result = await bridge.rebuildPageContainer(
          new RebuildPageContainer({
            containerTotalNum: CONTAINER_TOTAL,
            textObject: payload.textObject,
            imageObject: payload.imageObject,
          }),
        )
        // Only an explicit false counts as failure: a host that resolves a
        // non-boolean (despite the SDK type) must not permanently disable
        // rendering or icon pushes.
        rebuilt = result !== false
        if (!rebuilt) console.error('rebuildPageContainer returned false')
      } catch (err) {
        console.error('rebuildPageContainer failed', err)
        rebuilt = false
      }
      if (!rebuilt) {
        // Don't push icons onto a stale page; retry the whole rebuild so the
        // displayed screen catches up with the input state.
        if (retriesLeft > 0) {
          retriesLeft--
          renderDirty = true
          await new Promise(resolve => setTimeout(resolve, REBUILD_RETRY_DELAY_MS))
        }
        continue
      }
      retriesLeft = REBUILD_MAX_RETRIES
      // Icon raw data rides the same serialized loop as the rebuild, so a
      // page flip never interleaves BLE image writes with the next rebuild:
      // when the state goes dirty mid-push we abandon the rest (their
      // containers are about to be re-parked/moved anyway) and loop.
      await pushIcons(payload.iconPushes)
    } while (renderDirty)
  } finally {
    renderInFlight = false
  }
}

// PNG bytes are fetched once per kind and kept in memory; a failed fetch is
// evicted so a later render can retry. Any failure here only costs the
// pictograms — the route text is already on screen.
const iconBytesCache = new Map<RouteIconKind, Promise<Uint8Array>>()

function loadIconBytes(kind: RouteIconKind): Promise<Uint8Array> {
  let bytes = iconBytesCache.get(kind)
  if (!bytes) {
    bytes = fetch(`${import.meta.env.BASE_URL}icons/${kind}.png`).then(async res => {
      if (!res.ok) throw new Error(`icon fetch failed: ${res.status}`)
      return new Uint8Array(await res.arrayBuffer())
    })
    bytes.catch(() => iconBytesCache.delete(kind))
    iconBytesCache.set(kind, bytes)
  }
  return bytes
}

// updateImageRawData must be serial (one in flight at a time), and only
// while the just-rebuilt screen is still current.
async function pushIcons(pushes: IconPush[]): Promise<void> {
  if (!bridge) return
  for (const push of pushes) {
    if (renderDirty) return
    try {
      const bytes = await loadIconBytes(push.kind)
      if (renderDirty) return
      const result = await bridge.updateImageRawData(
        new ImageRawDataUpdate({
          containerID: push.containerID,
          containerName: push.containerName,
          imageData: bytes,
        }),
      )
      if (result !== ImageRawDataUpdateResult.success) {
        console.error(`updateImageRawData(${push.kind}) failed:`, result)
      }
    } catch (err) {
      console.error(`icon push (${push.kind}) failed`, err)
    }
  }
}

// getAppLocation may never resolve on hosts without location support, so we
// race it against our own timeout rather than trusting options.timeoutMs.
async function getCurrentLocation(): Promise<{ lat: number; lng: number; isDemo: boolean }> {
  if (!bridge) return { ...TOKYO_STATION_DEMO_ORIGIN, isDemo: true }
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
  return { ...TOKYO_STATION_DEMO_ORIGIN, isDemo: true }
}

async function startSearch(dest: Destination): Promise<void> {
  const token = ++searchToken
  screen = { kind: 'searching', dest, message: '現在地から経路を検索中...' }
  render()

  try {
    const origin = await getCurrentLocation()
    if (token !== searchToken) return
    const result = await searchRoutesFromOrigin(origin, dest)
    if (token !== searchToken) return

    if (result.plans.length === 0) {
      screen = result.isDemo
        ? { kind: 'error', dest, message: '経路が見つかりませんでした' }
        : { kind: 'unsupported', dest }
    } else {
      screen = {
        kind: 'candidates',
        dest,
        plans: result.plans,
        selectedIndex: 0,
        isDemo: result.isDemo,
      }
    }
    render()
  } catch {
    if (token !== searchToken) return
    screen = { kind: 'error', dest, message: '経路検索に失敗しました\n通信状態を確認してください' }
    render()
  }
}

async function startDemoSearch(dest: Destination): Promise<void> {
  const token = ++searchToken
  screen = { kind: 'searching', dest, message: '東京駅からデモ検索中...' }
  render()

  try {
    const result = await searchDemoRoutes(dest)
    if (token !== searchToken) return

    if (result.plans.length === 0) {
      screen = { kind: 'error', dest, message: 'デモ経路が見つかりませんでした' }
    } else {
      screen = {
        kind: 'candidates',
        dest,
        plans: result.plans,
        selectedIndex: 0,
        isDemo: true,
      }
    }
    render()
  } catch {
    if (token !== searchToken) return
    screen = { kind: 'error', dest, message: 'デモ検索に失敗しました\n通信状態を確認してください' }
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
    case 'unsupported':
      handleUnsupportedRegion(screen, eventType)
      break
    case 'candidates':
      handleCandidates(screen, eventType)
      break
    case 'route':
      handleRoute(screen, eventType)
      break
    case 'error':
      handleError(screen, eventType)
      break
  }
}

function handleUnsupportedRegion(
  current: Extract<Screen, { kind: 'unsupported' }>,
  eventType: OsEventTypeList,
): void {
  if (eventType === OsEventTypeList.CLICK_EVENT) {
    startDemoSearch(current.dest)
  } else if (eventType === OsEventTypeList.DOUBLE_CLICK_EVENT) {
    backToList()
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

function handleCandidates(
  current: Extract<Screen, { kind: 'candidates' }>,
  eventType: OsEventTypeList,
): void {
  if (eventType === OsEventTypeList.SCROLL_BOTTOM_EVENT) {
    if (current.selectedIndex < current.plans.length - 1) {
      screen = { ...current, selectedIndex: current.selectedIndex + 1 }
      render()
    }
  } else if (eventType === OsEventTypeList.SCROLL_TOP_EVENT) {
    if (current.selectedIndex > 0) {
      screen = { ...current, selectedIndex: current.selectedIndex - 1 }
      render()
    }
  } else if (eventType === OsEventTypeList.CLICK_EVENT) {
    const plan = current.plans[current.selectedIndex]
    if (!plan) return
    screen = {
      kind: 'route',
      dest: current.dest,
      plans: current.plans,
      planIndex: current.selectedIndex,
      lines: wrapLines(plan.lines),
      lineOffset: 0,
      isDemo: current.isDemo,
    }
    render()
  } else if (eventType === OsEventTypeList.DOUBLE_CLICK_EVENT) {
    backToList()
  }
}

function handleRoute(
  current: Extract<Screen, { kind: 'route' }>,
  eventType: OsEventTypeList,
): void {
  if (eventType === OsEventTypeList.SCROLL_BOTTOM_EVENT) {
    // Seamless line-wise scroll (issue #25): slide the 8-line window by
    // ROUTE_SCROLL_STEP instead of flipping whole pages.
    const next = Math.min(
      current.lineOffset + ROUTE_SCROLL_STEP,
      maxRouteLineOffset(current.lines),
    )
    if (next !== current.lineOffset) {
      screen = { ...current, lineOffset: next }
      render()
    }
  } else if (eventType === OsEventTypeList.SCROLL_TOP_EVENT) {
    const next = Math.max(current.lineOffset - ROUTE_SCROLL_STEP, 0)
    if (next !== current.lineOffset) {
      screen = { ...current, lineOffset: next }
      render()
    }
  } else if (eventType === OsEventTypeList.CLICK_EVENT) {
    startSearch(current.dest) // re-search from fresh position
  } else if (eventType === OsEventTypeList.DOUBLE_CLICK_EVENT) {
    // Back to the candidate list (not the destination list), with the
    // just-viewed candidate still selected.
    screen = {
      kind: 'candidates',
      dest: current.dest,
      plans: current.plans,
      selectedIndex: current.planIndex,
      isDemo: current.isDemo,
    }
    render()
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
