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
  routePageCount,
  buildRouteIcons,
  hiddenIconContainers,
  LINES_PER_PAGE,
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

// --- paging & icon containers -------------------------------------------

test('page and container constants match the SDK limits', () => {
  assert.equal(LINES_PER_PAGE, 8)
  assert.equal(CONTAINER_TOTAL, 12)
  assert.equal(ICON_CONTAINER_COUNT, 4)
})

test('routePageCount is ceil(lines / 8), minimum 1', () => {
  assert.equal(routePageCount([]), 1)
  assert.equal(routePageCount(Array.from({ length: 8 }, () => ({ text: 'x' }))), 1)
  assert.equal(routePageCount(Array.from({ length: 9 }, () => ({ text: 'x' }))), 2)
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
  const lines = Array.from({ length: LINES_PER_PAGE }, (_, i) => ({
    text: `ステップ${i}`,
    icon: 'walk',
  }))
  const { imageObject, pushes } = buildRouteIcons(lines, 0)
  assert.equal(imageObject.length, 4)
  assert.equal(pushes.length, 4)
})

test('buildRouteIcons: page slicing matches the rendered page', () => {
  const lines = [
    ...Array.from({ length: 8 }, (_, i) => ({ text: `p0-${i}` })),
    { text: 'p1-步', icon: 'walk' },
    { text: 'p1-線', icon: 'train' },
  ]
  const page0 = buildRouteIcons(lines, 0)
  assert.equal(page0.pushes.length, 0)
  const page1 = buildRouteIcons(lines, 1)
  assert.deepEqual(page1.pushes.map(p => p.kind), ['walk', 'train'])
  // page beyond the end clamps to the last page instead of going blank
  const clamped = buildRouteIcons(lines, 99)
  assert.deepEqual(clamped.pushes.map(p => p.kind), ['walk', 'train'])
})

test('hiddenIconContainers: 4 parked containers with stable IDs', () => {
  const hidden = hiddenIconContainers()
  assert.equal(hidden.length, 4)
  hidden.forEach((c, i) => {
    assert.equal(c.containerID, 9 + i)
    assert.ok(c.xPosition < 0 && c.yPosition < 0)
  })
})
