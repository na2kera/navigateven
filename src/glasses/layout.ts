import { TextContainerProperty } from '@evenrealities/even_hub_sdk'
import type { Destination } from '../types.ts'

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
export const CONTAINER_TOTAL = 8

export const VISIBLE_ROWS = 5
const ROW_H = Math.floor(BODY_H / VISIBLE_ROWS) // 46px

export const LINES_PER_PAGE = 9
const WRAP_BUDGET = 44 // half-width units per line

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
    buildHeader('NavigatEven  目的地を選択'),
  ]

  if (destinations.length === 0) {
    return buildBodyScreen(
      'NavigatEven  目的地を選択',
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

// --- Route (itinerary) screen ---

// Width-aware wrap: full-width chars count as 2 half-width units.
export function wrapLines(lines: string[]): string[] {
  const wrapped: string[] = []
  for (const line of lines) {
    let current = ''
    let width = 0
    for (const ch of line) {
      const w = ch.charCodeAt(0) > 0xff ? 2 : 1
      if (width + w > WRAP_BUDGET) {
        wrapped.push(current)
        current = '  '
        width = 2
      }
      current += ch
      width += w
    }
    wrapped.push(current)
  }
  return wrapped
}

export function routePageCount(wrappedLines: string[]): number {
  return Math.max(1, Math.ceil(wrappedLines.length / LINES_PER_PAGE))
}

export function buildRouteScreen(
  destName: string,
  wrappedLines: string[],
  page: number,
  isDemoLocation: boolean,
): TextContainerProperty[] {
  const pageCount = routePageCount(wrappedLines)
  const clampedPage = Math.min(page, pageCount - 1)
  const pageLines = wrappedLines.slice(
    clampedPage * LINES_PER_PAGE,
    (clampedPage + 1) * LINES_PER_PAGE,
  )

  const demoTag = isDemoLocation ? ' [DEMO位置]' : ''
  const pageTag = pageCount > 1 ? `  ${clampedPage + 1}/${pageCount}` : ''

  return buildBodyScreen(
    `→ ${destName}${demoTag}${pageTag}`,
    new TextContainerProperty({
      xPosition: 0, yPosition: BODY_Y,
      width: SCREEN_W, height: BODY_H,
      borderWidth: 0, borderColor: 0, paddingLength: 6,
      containerID: ID_ROW_BASE, containerName: 'row0',
      content: pageLines.join('\n') || ' ',
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
