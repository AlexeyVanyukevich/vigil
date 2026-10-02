import { describe, expect, it } from 'vitest'
import { frameRuns, relativeTime, splitFrames } from '../src/format'

const NOW = Date.parse('2026-09-07T12:00:00.000Z')
const SECOND = 1000
const MINUTE = 60 * SECOND
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

interface RelativeCase {
  name: string
  /** How long before `NOW` it happened; negative is in the future. */
  ago: number
  expected: string
}

const relative: RelativeCase[] = [
  { name: 'this instant', ago: 0, expected: 'just now' },
  { name: 'a few seconds ago', ago: 30 * SECOND, expected: 'just now' },
  { name: 'a millisecond short of a minute', ago: MINUTE - 1, expected: 'just now' },
  { name: 'exactly a minute', ago: MINUTE, expected: '1m ago' },
  { name: 'a millisecond short of an hour', ago: HOUR - 1, expected: '59m ago' },
  { name: 'exactly an hour', ago: HOUR, expected: '1h ago' },
  { name: 'a millisecond short of a day', ago: DAY - 1, expected: '23h ago' },
  { name: 'exactly a day', ago: DAY, expected: '1d ago' },
  { name: 'a millisecond short of thirty days', ago: 30 * DAY - 1, expected: '29d ago' },
  // Past a month "43d ago" stops meaning anything; the date does.
  { name: 'thirty days', ago: 30 * DAY, expected: '2026-08-08' },
  // A client clock running ahead files events in the future. That is still "now" to the owner.
  { name: 'in the future, from a clock running fast', ago: -5 * MINUTE, expected: 'just now' },
]

describe('relativeTime', () => {
  it.each(relative)('$name → $expected', ({ ago, expected }) => {
    expect(relativeTime(new Date(NOW - ago).toISOString(), NOW)).toBe(expected)
  })

  it('says it does not know rather than printing NaN', () => {
    expect(relativeTime('not a date', NOW)).toBe('unknown')
  })
})

interface FrameCase {
  name: string
  stack: string
  vendor: boolean[]
}

const frames: FrameCase[] = [
  {
    name: 'the message line and the owner’s own frames',
    stack: 'TypeError: boom\n    at handleBooking (/app/src/bookings.js:42:17)',
    vendor: [false, false],
  },
  {
    name: 'a dependency’s frame',
    stack: 'TypeError: boom\n    at run (/app/node_modules/fastify/lib/handle.js:118:9)',
    vendor: [false, true],
  },
  {
    name: 'a dependency’s frame on Windows',
    stack: 'Error: x\n    at run (C:\\app\\node_modules\\fastify\\lib\\handle.js:118:9)',
    vendor: [false, true],
  },
  {
    name: 'pnpm’s nested store is still a dependency',
    stack:
      'Error: x\n    at run (/app/node_modules/.pnpm/fastify@5.0.0/node_modules/fastify/lib/handle.js:1:1)',
    vendor: [false, true],
  },
  {
    name: 'a name that merely contains the word is the owner’s',
    stack: 'Error: x\n    at load (/app/src/node_modules_loader.js:3:1)',
    vendor: [false, false],
  },
  {
    name: 'line endings from Windows do not leave a carriage return on each frame',
    stack: 'Error: x\r\n    at a (/app/a.js:1:1)\r\n    at b (/app/node_modules/b/b.js:1:1)',
    vendor: [false, false, true],
  },
  // The first line is the error itself, whatever path its message names. Folding it would hide
  // what went wrong behind "N frames in node_modules", and count it as one of them.
  {
    name: 'an error line naming a dependency’s path is the message, not a frame',
    stack:
      "Error: ENOENT: no such file or directory, open '/app/node_modules/x/data.json'\n    at load (/app/src/a.js:1:1)",
    vendor: [false, false],
  },
  {
    name: 'a stack of nothing but dependency frames keeps its message out of them',
    stack:
      'Error: x\n    at a (/app/node_modules/a/a.js:1:1)\n    at b (/app/node_modules/b/b.js:1:1)',
    vendor: [false, true, true],
  },
]

describe('splitFrames', () => {
  it.each(frames)('$name', ({ stack, vendor }) => {
    const split = splitFrames(stack)
    expect(split.map((frame) => frame.vendor)).toEqual(vendor)
    expect(split.every((frame) => !frame.text.includes('\r'))).toBe(true)
  })
})

interface RunCase {
  name: string
  stack: string
  runs: Array<{ vendor: boolean; frames: number }>
}

const own = '    at mine (/app/src/a.js:1:1)'
const dep = '    at theirs (/app/node_modules/x/x.js:1:1)'

const runs: RunCase[] = [
  {
    name: 'a stack with no dependency frames is one run',
    stack: ['Error: x', own, own].join('\n'),
    runs: [{ vendor: false, frames: 3 }],
  },
  {
    name: 'consecutive dependency frames collapse together',
    stack: ['Error: x', own, dep, dep, dep, own].join('\n'),
    runs: [
      { vendor: false, frames: 2 },
      { vendor: true, frames: 3 },
      { vendor: false, frames: 1 },
    ],
  },
  {
    name: 'a single dependency frame is a run of its own',
    stack: ['Error: x', dep, own, dep].join('\n'),
    runs: [
      { vendor: false, frames: 1 },
      { vendor: true, frames: 1 },
      { vendor: false, frames: 1 },
      { vendor: true, frames: 1 },
    ],
  },
  {
    name: 'an error line naming a dependency’s path does not join the fold after it',
    stack: ["Error: ENOENT: open '/app/node_modules/x/data.json'", dep, dep].join('\n'),
    runs: [
      { vendor: false, frames: 1 },
      { vendor: true, frames: 2 },
    ],
  },
  {
    name: 'a stack of nothing but dependency frames folds all but its message',
    stack: ['Error: x', dep, dep, dep].join('\n'),
    runs: [
      { vendor: false, frames: 1 },
      { vendor: true, frames: 3 },
    ],
  },
]

describe('frameRuns', () => {
  it.each(runs)('$name', ({ stack, runs: expected }) => {
    expect(
      frameRuns(stack).map((run) => ({ vendor: run.vendor, frames: run.frames.length })),
    ).toEqual(expected)
  })

  it('keeps every line, in order', () => {
    const stack = ['Error: x', own, dep, dep, own].join('\n')
    expect(frameRuns(stack).flatMap((run) => run.frames)).toEqual(stack.split('\n'))
  })
})
