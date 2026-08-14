// Route display logic tests (issue #19 / PR #27 review).
//
// Runs on plain Node (>= 23.6, or >= 22.6 with --experimental-strip-types)
// via `npm test` — the TypeScript sources are imported directly through
// Node's built-in type stripping, so no test framework dependency is added.
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { formatJourney } from '../src/api/transit.ts'
import {
  wrapLines,
  maxRouteLineOffset,
  buildRouteIcons,
  buildRouteScreen,
  hiddenIconContainers,
  ROUTE_VISIBLE_LINES,
  ROUTE_SCROLL_STEP,
  CONTAINER_TOTAL,
  ICON_CONTAINER_COUNT,
} from '../src/glasses/layout.ts'

// --- fixtures ---------------------------------------------------------

let placeSeq = 0
function transitLeg(mode, opts = {}) {
  placeSeq += 2
  return {
    kind: 'transit',
    ...(mode === undefined ? {} : { mode }),
    ...opts,
    from: { id: `p${placeSeq - 1}`, name: `駅${placeSeq - 1}` },
    to: { id: `p${placeSeq}`, name: `駅${placeSeq}` },
    departureSecs: 32400,
    arrivalSecs: 33000,
  }
}

function walkLeg(secs = 300) {
  placeSeq += 2
  return {
    kind: 'walk',
    from: { id: `p${placeSeq - 1}`, name: `駅${placeSeq - 1}` },
    to: { id: `p${placeSeq}`, name: `駅${placeSeq}` },
    departureSecs: 33000,
    arrivalSecs: 33000 + secs,
  }
}

function journeyOf(legs, opts = {}) {
  return {
    departureSecs: 32400,
    arrivalSecs: 36000,
    durationSecs: 3600,
    transferCount: Math.max(0, legs.filter(l => l.kind === 'transit').length - 1),
    legs,
    ...opts,
  }
}

/** Icon of the step-head line whose text contains `substr` (undefined if none). */
function iconOfLine(lines, substr) {
  const line = lines.find(l => l.text.includes(substr))
  assert.ok(line, `line containing "${substr}" not found`)
  return line.icon
}

// --- mode → icon mapping ----------------------------------------------

test('mode mapping: rail-ish modes get the train icon', () => {
  for (const mode of ['rail', 'subway', 'tram', 'monorail', 'funicular', 'cableTram']) {
    const lines = formatJourney(journeyOf([transitLeg(mode, { routeName: `${mode}線` })]))
    assert.equal(iconOfLine(lines, `${mode}線`), 'train', mode)
  }
})

test('mode mapping: bus and trolleybus get the bus icon', () => {
  for (const mode of ['bus', 'trolleybus']) {
    const lines = formatJourney(journeyOf([transitLeg(mode, { routeName: `${mode}路線` })]))
    assert.equal(iconOfLine(lines, `${mode}路線`), 'bus', mode)
  }
})

test('mode mapping: ferry / air / aerialLift get NO icon (not a wrong train)', () => {
  for (const mode of ['ferry', 'air', 'aerialLift']) {
    const lines = formatJourney(journeyOf([transitLeg(mode, { routeName: `${mode}航路` })]))
    assert.equal(iconOfLine(lines, `${mode}航路`), undefined, mode)
  }
})

test('mode mapping: missing or unknown future modes fall back to train (issue #19)', () => {
  const missing = formatJourney(journeyOf([transitLeg(undefined, { routeName: '謎線' })]))
  assert.equal(iconOfLine(missing, '謎線'), 'train')
  const unknown = formatJourney(journeyOf([transitLeg('maglev', { routeName: 'リニア線' })]))
  assert.equal(iconOfLine(unknown, 'リニア線'), 'train')
})

test('walk steps get the walk icon; access/egress walks are merged in', () => {
  const lines = formatJourney(
    journeyOf([walkLeg(120), transitLeg('rail', { routeName: '山手線' })], {
      accessWalkSecs: 60,
      egressWalkSecs: 90,
    }),
  )
  const walkLines = lines.filter(l => l.icon === 'walk')
  // access(60)+leg(120) merge into one leading walk, egress(90) is its own step
  assert.equal(walkLines.length, 2)
  assert.match(walkLines[0].text, /^徒歩 3分/)
})

test('label fallback: ferry without routeName is not captioned 列車', () => {
  const lines = formatJourney(journeyOf([transitLeg('ferry')]))
  assert.ok(lines.some(l => l.text === 'フェリー'), JSON.stringify(lines))
})

test('header and station/time lines carry no icon', () => {
  const lines = formatJourney(journeyOf([transitLeg('rail', { routeName: '山手線' })]))
  assert.equal(lines[0].icon, undefined) // 出発 …
  assert.equal(lines[1].icon, undefined) // 所要 …
  for (const l of lines.filter(l => l.text.startsWith('   '))) {
    assert.equal(l.icon, undefined, l.text)
  }
})

// --- wrapping ----------------------------------------------------------

test('wrap continuations indent 2 spaces and never inherit the icon', () => {
  const wrapped = wrapLines([{ text: 'ながい路線名'.padEnd(60, 'あ'), icon: 'train' }])
  assert.ok(wrapped.length > 1)
  assert.equal(wrapped[0].icon, 'train')
  for (const cont of wrapped.slice(1)) {
    assert.equal(cont.icon, undefined)
    assert.match(cont.text, /^ {2}\S/)
  }
})

// --- line-wise scrolling & icon containers -------------------------------

test('window and container constants match the SDK limits', () => {
  assert.equal(ROUTE_VISIBLE_LINES, 8)
  assert.equal(ROUTE_SCROLL_STEP, 2)
  assert.equal(CONTAINER_TOTAL, 12)
  assert.equal(ICON_CONTAINER_COUNT, 4)
})

test('maxRouteLineOffset is lines - 8, minimum 0', () => {
  assert.equal(maxRouteLineOffset([]), 0)
  assert.equal(maxRouteLineOffset(Array.from({ length: 8 }, () => ({ text: 'x' }))), 0)
  assert.equal(maxRouteLineOffset(Array.from({ length: 9 }, () => ({ text: 'x' }))), 1)
  assert.equal(maxRouteLineOffset(Array.from({ length: 20 }, () => ({ text: 'x' }))), 12)
})

test('buildRouteIcons: payload always carries 4 containers (IDs 9..12), unused parked off-screen', () => {
  const lines = [
    { text: 'ヘッダ' },
    { text: '徒歩 5分', icon: 'walk' },
    { text: '山手線', icon: 'train' },
  ]
  const { imageObject, pushes } = buildRouteIcons(lines, 0)
  assert.equal(imageObject.length, 4)
  assert.deepEqual(imageObject.map(c => c.containerID), [9, 10, 11, 12])
  assert.equal(pushes.length, 2)
  for (const c of imageObject.slice(0, 2)) {
    assert.equal(c.xPosition, 6)
    assert.equal(c.width, 20)
    assert.equal(c.height, 20)
  }
  for (const c of imageObject.slice(2)) {
    assert.ok(c.xPosition < 0 && c.yPosition < 0, 'unused icon must be parked off-screen')
  }
})

test('buildRouteIcons: icon Y follows the measured 27px line pitch (28 + 6 + i*27 + 4)', () => {
  const lines = [
    { text: 'ヘッダ' },
    { text: '徒歩 5分', icon: 'walk' },
    { text: '山手線', icon: 'train' },
  ]
  const { imageObject } = buildRouteIcons(lines, 0)
  assert.equal(imageObject[0].yPosition, 28 + 6 + 1 * 27 + 4)
  assert.equal(imageObject[1].yPosition, 28 + 6 + 2 * 27 + 4)
})

test('buildRouteIcons: more icon lines than containers are capped at 4, text untouched', () => {
  // Cannot happen with real journeys (walk merging), but the SDK limit of 4
  // imageObject entries must hold even against synthetic/hostile input.
  const lines = Array.from({ length: ROUTE_VISIBLE_LINES }, (_, i) => ({
    text: `ステップ${i}`,
    icon: 'walk',
  }))
  const { imageObject, pushes } = buildRouteIcons(lines, 0)
  assert.equal(imageObject.length, 4)
  assert.equal(pushes.length, 4)
})

test('buildRouteIcons: window slicing follows the line offset', () => {
  const lines = [
    ...Array.from({ length: 8 }, (_, i) => ({ text: `head-${i}` })),
    { text: 'tail-步', icon: 'walk' },
    { text: 'tail-線', icon: 'train' },
  ]
  // offset 0: window is lines 0..7, no icons
  assert.equal(buildRouteIcons(lines, 0).pushes.length, 0)
  // offset 1: window is lines 1..8, walk enters at window index 7
  const shifted = buildRouteIcons(lines, 1)
  assert.deepEqual(shifted.pushes.map(p => p.kind), ['walk'])
  assert.equal(shifted.imageObject[0].yPosition, 28 + 6 + 7 * 27 + 4)
  // offset at max (2): both tail icons visible
  const atEnd = buildRouteIcons(lines, maxRouteLineOffset(lines))
  assert.deepEqual(atEnd.pushes.map(p => p.kind), ['walk', 'train'])
  // offset beyond the end clamps to the last window instead of going blank
  const clamped = buildRouteIcons(lines, 99)
  assert.deepEqual(clamped.pushes.map(p => p.kind), ['walk', 'train'])
})

test('densest real pattern never exceeds 4 icons in ANY 8-line window', () => {
  // walk(1 line) + transit(3 lines) repeated is the densest sequence a real
  // journey can produce (consecutive walks are merged). Every scroll offset
  // must stay within the SDK's 4-image-container limit without dropping
  // icons that belong to the window.
  const lines = []
  for (let i = 0; i < 5; i++) {
    lines.push({ text: `徒歩 ${i}分`, icon: 'walk' })
    lines.push({ text: `路線${i}`, icon: 'train' })
    lines.push({ text: `   駅A ${i}` })
    lines.push({ text: `   → 駅B ${i}` })
  }
  for (let offset = 0; offset <= maxRouteLineOffset(lines); offset++) {
    const { pushes } = buildRouteIcons(lines, offset)
    const expected = lines
      .slice(offset, offset + ROUTE_VISIBLE_LINES)
      .filter(l => l.icon).length
    assert.ok(expected <= ICON_CONTAINER_COUNT, `offset ${offset}: ${expected} icon lines`)
    assert.equal(pushes.length, expected, `offset ${offset}`)
  }
})

test('buildRouteScreen: header shows ▲▼ scroll hints instead of page numbers', () => {
  const lines = Array.from({ length: 12 }, (_, i) => ({ text: `行${i}` }))
  const headerOf = offset =>
    buildRouteScreen('新宿', lines, offset, false).find(c => c.containerName === 'header').content
  // ▲ slot is a placeholder space at the top so ▼ keeps a stable position
  assert.equal(headerOf(0), '→ 新宿   ▼')
  assert.equal(headerOf(2), '→ 新宿  ▲▼')
  assert.equal(headerOf(4), '→ 新宿  ▲ ')
  // short routes need no hint at all
  const short = Array.from({ length: 8 }, (_, i) => ({ text: `行${i}` }))
  assert.equal(
    buildRouteScreen('新宿', short, 0, false).find(c => c.containerName === 'header').content,
    '→ 新宿',
  )
})

test('buildRouteScreen: body text is the 8-line window at the given offset', () => {
  const lines = Array.from({ length: 12 }, (_, i) => ({ text: `行${i}` }))
  const bodyOf = offset =>
    buildRouteScreen('新宿', lines, offset, false).find(c => c.containerName === 'row0').content
  assert.equal(bodyOf(0), lines.slice(0, 8).map(l => l.text).join('\n'))
  assert.equal(bodyOf(2), lines.slice(2, 10).map(l => l.text).join('\n'))
  // clamped past the end: last full window, not a short tail
  assert.equal(bodyOf(99), lines.slice(4, 12).map(l => l.text).join('\n'))
})

test('hiddenIconContainers: 4 parked containers with stable IDs', () => {
  const hidden = hiddenIconContainers()
  assert.equal(hidden.length, 4)
  hidden.forEach((c, i) => {
    assert.equal(c.containerID, 9 + i)
    assert.ok(c.xPosition < 0 && c.yPosition < 0)
  })
})
