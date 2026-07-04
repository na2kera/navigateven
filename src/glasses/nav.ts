import {
  type EvenAppBridge,
  type AppLocation,
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

type Mode = 'list' | 'searching' | 'route' | 'error'

// Fallback when the host returns no position (the simulator does not
// implement the location bridge at all). Tokyo Station.
const DEMO_LOCATION = { lat: 35.6812, lng: 139.7671 }
const LOCATION_TIMEOUT_MS = 8000

let bridge: EvenAppBridge | null = null
let mode: Mode = 'list'
let destinations: Destination[] = []
let selectedIndex = 0
let scrollOffset = 0
let currentDest: Destination | null = null
let routeLines: string[] = []
let routePage = 0
let isDemoLocation = false
let errorMessage = ''
let searchToken = 0

export async function initGlasses(evenBridge: EvenAppBridge): Promise<void> {
  bridge = evenBridge
  destinations = getAllDestinations()
  await bridge.createStartUpPageContainer(
    new CreateStartUpPageContainer({
      containerTotalNum: CONTAINER_TOTAL,
      textObject: buildListScreen(destinations, selectedIndex, scrollOffset),
      imageObject: [],
    }),
  )
}

// Called by the phone UI after add/edit/delete so the glasses list stays fresh.
export async function refreshDestinations(): Promise<void> {
  destinations = getAllDestinations()
  if (selectedIndex >= destinations.length) {
    selectedIndex = Math.max(0, destinations.length - 1)
  }
  scrollOffset = Math.min(scrollOffset, Math.max(0, destinations.length - VISIBLE_ROWS))
  if (mode === 'list') await pushRebuild()
}

async function pushRebuild(): Promise<void> {
  if (!bridge) return
  let containers
  if (mode === 'list') {
    containers = buildListScreen(destinations, selectedIndex, scrollOffset)
  } else if (mode === 'searching') {
    containers = buildMessageScreen(
      `→ ${currentDest?.name ?? ''}`,
      '経路を検索中...',
      '2回タップ: 戻る',
    )
  } else if (mode === 'error') {
    containers = buildMessageScreen(
      `→ ${currentDest?.name ?? ''}`,
      errorMessage,
      'タップ:再試行  2回:戻る',
    )
  } else {
    containers = buildRouteScreen(
      currentDest?.name ?? '',
      routeLines,
      routePage,
      isDemoLocation,
    )
  }
  await bridge.rebuildPageContainer(
    new RebuildPageContainer({
      containerTotalNum: CONTAINER_TOTAL,
      textObject: containers,
      imageObject: [],
    }),
  )
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
  currentDest = dest
  mode = 'searching'
  await pushRebuild()

  try {
    const origin = await getCurrentLocation()
    if (token !== searchToken) return
    const plan = await planRoute(origin, dest)
    if (token !== searchToken) return

    if (!plan) {
      mode = 'error'
      errorMessage = '経路が見つかりませんでした'
      await pushRebuild()
      return
    }
    isDemoLocation = origin.isDemo
    routeLines = wrapLines(plan.lines)
    routePage = 0
    mode = 'route'
    await pushRebuild()
  } catch {
    if (token !== searchToken) return
    mode = 'error'
    errorMessage = '経路検索に失敗しました\n通信状態を確認してください'
    await pushRebuild()
  }
}

function backToList(): void {
  searchToken++ // invalidate any in-flight search
  mode = 'list'
  currentDest = null
  routeLines = []
  routePage = 0
  pushRebuild()
}

// Event handling — call this from onEvenHubEvent
export function handleInput(eventType: OsEventTypeList): void {
  switch (mode) {
    case 'list':      handleList(eventType);      break
    case 'searching': handleSearching(eventType); break
    case 'route':     handleRoute(eventType);     break
    case 'error':     handleError(eventType);     break
  }
}

function handleList(eventType: OsEventTypeList): void {
  if (eventType === OsEventTypeList.SCROLL_TOP_EVENT) {
    if (selectedIndex < destinations.length - 1) {
      selectedIndex++
      if (selectedIndex >= scrollOffset + VISIBLE_ROWS) scrollOffset++
      pushRebuild()
    }
  } else if (eventType === OsEventTypeList.SCROLL_BOTTOM_EVENT) {
    if (selectedIndex > 0) {
      selectedIndex--
      if (selectedIndex < scrollOffset) scrollOffset--
      pushRebuild()
    }
  } else if (eventType === OsEventTypeList.CLICK_EVENT) {
    const dest = destinations[selectedIndex]
    if (dest) startSearch(dest)
  } else if (eventType === OsEventTypeList.DOUBLE_CLICK_EVENT) {
    bridge?.shutDownPageContainer(1)
  }
}

function handleSearching(eventType: OsEventTypeList): void {
  if (eventType === OsEventTypeList.DOUBLE_CLICK_EVENT) {
    backToList()
  }
}

function handleRoute(eventType: OsEventTypeList): void {
  if (eventType === OsEventTypeList.SCROLL_TOP_EVENT) {
    if (routePage < routePageCount(routeLines) - 1) {
      routePage++
      pushRebuild()
    }
  } else if (eventType === OsEventTypeList.SCROLL_BOTTOM_EVENT) {
    if (routePage > 0) {
      routePage--
      pushRebuild()
    }
  } else if (eventType === OsEventTypeList.CLICK_EVENT) {
    if (currentDest) startSearch(currentDest) // re-search from fresh position
  } else if (eventType === OsEventTypeList.DOUBLE_CLICK_EVENT) {
    backToList()
  }
}

function handleError(eventType: OsEventTypeList): void {
  if (eventType === OsEventTypeList.CLICK_EVENT) {
    if (currentDest) startSearch(currentDest)
  } else if (eventType === OsEventTypeList.DOUBLE_CLICK_EVENT) {
    backToList()
  }
}
