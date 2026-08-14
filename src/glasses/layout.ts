import { TextContainerProperty, ImageContainerProperty } from '@evenrealities/even_hub_sdk'
import type { Destination } from '../types.ts'
import {
  secsToClock,
  type RoutePlan,
  type RouteDisplayLine,
  type RouteIconKind,
} from '../api/transit.ts'

// Display constants (Even G2 canvas, same as timetableven)
const SCREEN_W = 576
const SCREEN_H = 288
const HEADER_H = 28
const FOOTER_H = 28
const BODY_Y = HEADER_H
const BODY_H = SCREEN_H - HEADER_H - FOOTER_H

// Container IDs — the rebuild payload must always carry the same ID set,
// unused ones parked off-screen (timetableven idiom).
export const ID_CAPTURE = 1
export const ID_HEADER = 2
const ID_ROW_BASE = 3 // 3..7
export const ID_FOOTER = 8
const ID_ICON_BASE = 9 // 9..12, route step icons (issue #19)
export const ICON_CONTAINER_COUNT = 4 // hard SDK limit: max 4 imageObject entries
export const CONTAINER_TOTAL = 12

export const VISIBLE_ROWS = 5
const ROW_H = Math.floor(BODY_H / VISIBLE_ROWS) // 46px

// An 8-line window keeps the number of step-head lines (= icons) within the
// 4-image-container limit and gives the bottom line breathing room. The
// densest real line pattern is walk(1)+transit(3) = 2 icons per 4 lines, so
// ANY 8 consecutive lines carry at most 4 icons — the limit holds at every
// scroll offset, not just page-aligned ones (issue #25).
export const ROUTE_VISIBLE_LINES = 8
// Lines moved per scroll gesture. 1 needs too many gestures to read a long
// route; whole-window jumps lose reading context (the issue #25 complaint).
export const ROUTE_SCROLL_STEP = 2
const WRAP_BUDGET = 44 // half-width units per line

// Route body text metrics, measured pixel-exact on simulator v0.7.3
// (issue #19): 27px line pitch, glyphs sit ~5px below the line-box top with
// ~18px visible height. A 20x20 icon centered on the glyph band starts 4px
// below the line-box top. Re-measure on real glasses — the simulator README
// warns font rendering may differ.
const ROUTE_TEXT_PADDING = 6
const ROUTE_LINE_PITCH = 27
const ICON_SIZE = 20
const ICON_X = 6
const ICON_Y_OFFSET = 4
// The body text container starts right of the icon gutter (text at x=32),
// so icons can never overlap text regardless of font metrics. The body font
// is proportional (a half-width space is ~5px), so indenting text out of the
// gutter with spaces would not survive a font change.
const ROUTE_TEXT_X = 32
// Text area shrank by 26px vs the full-width layout; 2 half-width units off
// the wrap budget keeps lines from overflowing into a renderer-side wrap
// (which would break the line↔icon correspondence).
const ROUTE_WRAP_BUDGET = WRAP_BUDGET - 2

function buildCapture(): TextContainerProperty {
  return new TextContainerProperty({
    xPosition: 0, yPosition: 0,
    width: SCREEN_W, height: SCREEN_H,
    borderWidth: 0, borderColor: 0, paddingLength: 0,
    containerID: ID_CAPTURE, containerName: 'eventLayer',
    content: ' ', isEventCapture: 1,
  })
}

function buildHeader(text: string): TextContainerProperty {
  return new TextContainerProperty({
    xPosition: 0, yPosition: 0,
    width: SCREEN_W, height: HEADER_H,
    borderWidth: 0, borderColor: 8, paddingLength: 4,
    containerID: ID_HEADER, containerName: 'header',
    content: text, isEventCapture: 0,
  })
}

function buildFooter(text: string): TextContainerProperty {
  return new TextContainerProperty({
    xPosition: 0, yPosition: SCREEN_H - FOOTER_H,
    width: SCREEN_W, height: FOOTER_H,
    borderWidth: 0, borderColor: 8, paddingLength: 4,
    containerID: ID_FOOTER, containerName: 'footer',
    content: text, isEventCapture: 0,
  })
}

function hiddenRow(index: number): TextContainerProperty {
  return new TextContainerProperty({
    xPosition: -10, yPosition: -10,
    width: 10, height: 10,
    borderWidth: 0, borderColor: 0, paddingLength: 0,
    containerID: ID_ROW_BASE + index, containerName: `row${index}`,
    content: ' ', isEventCapture: 0,
  })
}

// Rebuild payloads must always carry all row IDs; pad the unused tail here so
// every screen builder shares one source of truth for the row-count invariant.
function hiddenRows(fromIndex: number): TextContainerProperty[] {
  return Array.from(
    { length: VISIBLE_ROWS - fromIndex },
    (_, i) => hiddenRow(fromIndex + i),
  )
}

// Shared shape of every non-list screen: capture + header + one body
// container (ID_ROW_BASE) + hidden remaining rows + footer.
function buildBodyScreen(
  headerText: string,
  body: TextContainerProperty,
  footerText: string,
): TextContainerProperty[] {
  return [buildCapture(), buildHeader(headerText), body, ...hiddenRows(1), buildFooter(footerText)]
}

// --- Destination list screen ---

export function buildListScreen(
  destinations: Destination[],
  selectedIndex: number,
  scrollOffset: number,
): TextContainerProperty[] {
  const containers: TextContainerProperty[] = [
    buildCapture(),
    buildHeader('Route Planner  目的地を選択'),
  ]

  if (destinations.length === 0) {
    return buildBodyScreen(
      'Route Planner  目的地を選択',
      new TextContainerProperty({
        xPosition: 20, yPosition: BODY_Y + 40,
        width: SCREEN_W - 40, height: 60,
        borderWidth: 0, borderColor: 0, paddingLength: 4,
        containerID: ID_ROW_BASE, containerName: 'row0',
        content: '目的地がありません\nスマホで目的地を登録してください',
        isEventCapture: 0,
      }),
      '2回タップ: 終了',
    )
  }

  const total = destinations.length
  const above = scrollOffset > 0
  const below = scrollOffset + VISIBLE_ROWS < total

  for (let i = 0; i < VISIBLE_ROWS; i++) {
    const dest = destinations[scrollOffset + i]
    if (!dest) {
      containers.push(hiddenRow(i))
      continue
    }
    const isSelected = scrollOffset + i === selectedIndex
    const marker = isSelected ? '▶ ' : '  '
    containers.push(new TextContainerProperty({
      xPosition: 8, yPosition: BODY_Y + i * ROW_H,
      width: SCREEN_W - 16, height: ROW_H - 4,
      borderWidth: isSelected ? 2 : 1,
      borderColor: isSelected ? 15 : 6,
      paddingLength: 4,
      containerID: ID_ROW_BASE + i, containerName: `row${i}`,
      content: `${marker}${dest.name}`,
      isEventCapture: 0,
    }))
  }

  const scrollHint = `${above ? '▲' : ' '}${below ? '▼' : ' '}`
  containers.push(buildFooter(
    `${scrollHint} ${selectedIndex + 1}/${total}  タップ:検索  2回:終了`,
  ))
  return containers
}

// --- Route candidates screen ---

// Single-row summaries must not wrap (each candidate is one fixed-height
// row), so overflow is cut with an ellipsis instead of wrapped.
function truncateToWidth(text: string, budget: number): string {
  let width = 0
  let out = ''
  for (const ch of text) {
    const w = ch.charCodeAt(0) > 0xff ? 2 : 1
    if (width + w > budget - 1) return out + '…'
    out += ch
    width += w
  }
  return out
}

function candidateSummary(plan: RoutePlan, marker: string): string {
  const durationMin = Math.round(plan.durationSecs / 60)
  const head =
    `${marker}${secsToClock(plan.departureSecs)}→${secsToClock(plan.arrivalSecs)}` +
    ` ${durationMin}分 乗換${plan.transferCount}`
  const routes = plan.routeNames.join('・')
  return truncateToWidth(routes ? `${head} ${routes}` : head, WRAP_BUDGET)
}

// Same selection idiom as the destination list. planRoutes caps candidates
// at 4 (< VISIBLE_ROWS), so no scroll window is needed here.
export function buildCandidatesScreen(
  destName: string,
  plans: RoutePlan[],
  selectedIndex: number,
  isDemoLocation: boolean,
): TextContainerProperty[] {
  const demoTag = isDemoLocation ? ' [DEMO位置]' : ''
  const containers: TextContainerProperty[] = [
    buildCapture(),
    buildHeader(`→ ${destName}${demoTag}  経路候補`),
  ]

  for (let i = 0; i < VISIBLE_ROWS; i++) {
    const plan = plans[i]
    if (!plan) {
      containers.push(hiddenRow(i))
      continue
    }
    const isSelected = i === selectedIndex
    containers.push(new TextContainerProperty({
      xPosition: 8, yPosition: BODY_Y + i * ROW_H,
      width: SCREEN_W - 16, height: ROW_H - 4,
      borderWidth: isSelected ? 2 : 1,
      borderColor: isSelected ? 15 : 6,
      paddingLength: 4,
      containerID: ID_ROW_BASE + i, containerName: `row${i}`,
      content: candidateSummary(plan, isSelected ? '▶ ' : '  '),
      isEventCapture: 0,
    }))
  }

  containers.push(buildFooter(
    `${selectedIndex + 1}/${plans.length}  スクロール:選択  タップ:詳細  2回:戻る`,
  ))
  return containers
}

// --- Route (itinerary) screen ---

// Width-aware wrap: full-width chars count as 2 half-width units.
// Continuation lines never inherit the icon — it marks the step head only.
export function wrapLines(lines: RouteDisplayLine[]): RouteDisplayLine[] {
  const wrapped: RouteDisplayLine[] = []
  for (const line of lines) {
    let current = ''
    let width = 0
    let icon = line.icon
    for (const ch of line.text) {
      const w = ch.charCodeAt(0) > 0xff ? 2 : 1
      if (width + w > ROUTE_WRAP_BUDGET) {
        wrapped.push(icon ? { text: current, icon } : { text: current })
        icon = undefined
        current = '  '
        width = 2
      }
      current += ch
      width += w
    }
    wrapped.push(icon ? { text: current, icon } : { text: current })
  }
  return wrapped
}

// Largest valid scroll offset: the last window shows the final 8 lines.
export function maxRouteLineOffset(wrappedLines: RouteDisplayLine[]): number {
  return Math.max(0, wrappedLines.length - ROUTE_VISIBLE_LINES)
}

function clampOffset(wrappedLines: RouteDisplayLine[], lineOffset: number): number {
  return Math.max(0, Math.min(lineOffset, maxRouteLineOffset(wrappedLines)))
}

function routeWindowLines(
  wrappedLines: RouteDisplayLine[],
  lineOffset: number,
): RouteDisplayLine[] {
  const offset = clampOffset(wrappedLines, lineOffset)
  return wrappedLines.slice(offset, offset + ROUTE_VISIBLE_LINES)
}

// Raw-data push for one icon container, executed serially after the rebuild.
export interface IconPush {
  containerID: number
  containerName: string
  kind: RouteIconKind
}

function iconContainerName(index: number): string {
  return `icon${index}`
}

function hiddenIcon(index: number): ImageContainerProperty {
  // Same off-screen parking idiom as hiddenRow, but image containers have a
  // 20px minimum size, so park fully above-left of the origin.
  return new ImageContainerProperty({
    xPosition: -ICON_SIZE, yPosition: -ICON_SIZE,
    width: ICON_SIZE, height: ICON_SIZE,
    containerID: ID_ICON_BASE + index,
    containerName: iconContainerName(index),
  })
}

// Every rebuild payload must carry all 4 image container IDs; non-route
// screens park them all off-screen.
export function hiddenIconContainers(): ImageContainerProperty[] {
  return Array.from({ length: ICON_CONTAINER_COUNT }, (_, i) => hiddenIcon(i))
}

// Positions the step icons of the visible window (x=6, one per step-head
// line), parking the unused tail. Lines beyond the 4th icon keep their text
// but drop the icon — with merged walk steps and an 8-line window this
// cannot happen structurally, so this is only a guard for the SDK's hard
// limit.
export function buildRouteIcons(
  wrappedLines: RouteDisplayLine[],
  lineOffset: number,
): { imageObject: ImageContainerProperty[]; pushes: IconPush[] } {
  const windowLines = routeWindowLines(wrappedLines, lineOffset)
  const imageObject: ImageContainerProperty[] = []
  const pushes: IconPush[] = []

  windowLines.forEach((line, lineIndex) => {
    if (!line.icon || pushes.length >= ICON_CONTAINER_COUNT) return
    const index = pushes.length
    imageObject.push(new ImageContainerProperty({
      xPosition: ICON_X,
      yPosition: BODY_Y + ROUTE_TEXT_PADDING + lineIndex * ROUTE_LINE_PITCH + ICON_Y_OFFSET,
      width: ICON_SIZE, height: ICON_SIZE,
      containerID: ID_ICON_BASE + index,
      containerName: iconContainerName(index),
    }))
    pushes.push({
      containerID: ID_ICON_BASE + index,
      containerName: iconContainerName(index),
      kind: line.icon,
    })
  })

  for (let i = imageObject.length; i < ICON_CONTAINER_COUNT; i++) {
    imageObject.push(hiddenIcon(i))
  }
  return { imageObject, pushes }
}

export function buildRouteScreen(
  destName: string,
  wrappedLines: RouteDisplayLine[],
  lineOffset: number,
  isDemoLocation: boolean,
): TextContainerProperty[] {
  const maxOffset = maxRouteLineOffset(wrappedLines)
  const offset = clampOffset(wrappedLines, lineOffset)
  const windowLines = routeWindowLines(wrappedLines, offset)

  const demoTag = isDemoLocation ? ' [DEMO位置]' : ''
  // ▲▼ scroll hint (same idiom as the destination list) instead of the old
  // 1/2 page tag — the route scrolls line-wise now, pages no longer exist.
  const scrollTag = maxOffset > 0
    ? `  ${offset > 0 ? '▲' : ' '}${offset < maxOffset ? '▼' : ' '}`
    : ''

  // Container left edge sits at ROUTE_TEXT_X - padding so the first glyph
  // column lands exactly on ROUTE_TEXT_X, clear of the icon gutter.
  return buildBodyScreen(
    `→ ${destName}${demoTag}${scrollTag}`,
    new TextContainerProperty({
      xPosition: ROUTE_TEXT_X - ROUTE_TEXT_PADDING, yPosition: BODY_Y,
      width: SCREEN_W - (ROUTE_TEXT_X - ROUTE_TEXT_PADDING), height: BODY_H,
      borderWidth: 0, borderColor: 0, paddingLength: ROUTE_TEXT_PADDING,
      containerID: ID_ROW_BASE, containerName: 'row0',
      content: windowLines.map(l => l.text).join('\n') || ' ',
      isEventCapture: 0,
    }),
    'スクロール:送り  タップ:再検索  2回:戻る',
  )
}

// --- Message screen (loading / error) ---

export function buildMessageScreen(
  headerText: string,
  message: string,
  footerText: string,
): TextContainerProperty[] {
  return buildBodyScreen(
    headerText,
    new TextContainerProperty({
      xPosition: 20, yPosition: BODY_Y + 60,
      width: SCREEN_W - 40, height: 100,
      borderWidth: 0, borderColor: 0, paddingLength: 4,
      containerID: ID_ROW_BASE, containerName: 'row0',
      content: message,
      isEventCapture: 0,
    }),
    footerText,
  )
}
