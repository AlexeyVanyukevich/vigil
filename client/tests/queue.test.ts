import { describe, expect, it } from 'vitest'
import { EventQueue } from '../src/queue.js'
import { toWireEvent } from '../src/payload.js'

const event = (message: string, stack = 'Error: x\n    at f (/a.js:1:1)') => ({
  ...toWireEvent(new Error(message), undefined, []),
  stack,
})

describe('EventQueue', () => {
  it('hands back what it was given, oldest first', () => {
    const queue = new EventQueue(10)
    queue.add(event('one'))
    queue.add(event('two'))
    expect(queue.drain().map((e) => e.message)).toEqual(['one', 'two'])
  })

  it('is empty after draining', () => {
    const queue = new EventQueue(10)
    queue.add(event('one'))
    queue.drain()
    expect(queue.size()).toBe(0)
    expect(queue.drain()).toEqual([])
  })

  // §8: a hot loop throwing the same error fifty thousand times sends one event with
  // count: 50000. Without this the first real incident takes the monitor down.
  it('collapses repeats of the same failure into one counted event', () => {
    const queue = new EventQueue(10)
    for (let i = 0; i < 50_000; i += 1) queue.add(event('boom'))

    const drained = queue.drain()
    expect(drained).toHaveLength(1)
    expect(drained[0]!.count).toBe(50_000)
  })

  it('keeps different failures apart while collapsing', () => {
    const queue = new EventQueue(10)
    queue.add(event('boom'))
    queue.add(event('other'))
    queue.add(event('boom'))

    const drained = queue.drain()
    expect(drained).toHaveLength(2)
    expect(drained.map((e) => [e.message, e.count])).toEqual([
      ['boom', 2],
      ['other', 1],
    ])
  })

  it('keeps the first timestamp of a collapsed run, which is when it started', () => {
    const queue = new EventQueue(10)
    const first = { ...event('boom'), occurred_at: '2026-09-07T10:00:00.000Z' }
    const later = { ...event('boom'), occurred_at: '2026-09-07T10:05:00.000Z' }
    queue.add(first)
    queue.add(later)
    expect(queue.drain()[0]!.occurred_at).toBe('2026-09-07T10:00:00.000Z')
  })

  it('adds an already-counted event to the run rather than replacing it', () => {
    const queue = new EventQueue(10)
    queue.add({ ...event('boom'), count: 3 })
    queue.add({ ...event('boom'), count: 4 })
    expect(queue.drain()[0]!.count).toBe(7)
  })

  // §8: a vigil outage must never grow the host application's heap. Dropping the oldest keeps
  // what is happening now, which is what the owner will be asked about.
  it('is bounded, and drops the oldest when it is full', () => {
    const queue = new EventQueue(3)
    for (let i = 0; i < 10; i += 1) queue.add(event(`failure ${i}`))

    const drained = queue.drain()
    expect(drained).toHaveLength(3)
    expect(drained.map((e) => e.message)).toEqual(['failure 7', 'failure 8', 'failure 9'])
  })

  it('counts what it dropped, so the client can say so once', () => {
    const queue = new EventQueue(2)
    for (let i = 0; i < 5; i += 1) queue.add(event(`failure ${i}`))
    expect(queue.dropped).toBe(3)
  })

  // The bound is on distinct failures. Collapsing must not be what pushes the queue over it.
  it('does not count a collapsed repeat against the bound', () => {
    const queue = new EventQueue(2)
    queue.add(event('a'))
    queue.add(event('b'))
    for (let i = 0; i < 100; i += 1) queue.add(event('a'))

    expect(queue.dropped).toBe(0)
    expect(queue.drain().map((e) => [e.message, e.count])).toEqual([
      ['a', 101],
      ['b', 1],
    ])
  })

  it('accepts a queue of one', () => {
    const queue = new EventQueue(1)
    queue.add(event('a'))
    queue.add(event('b'))
    expect(queue.drain().map((e) => e.message)).toEqual(['b'])
  })

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    'refuses a bound of %s, which could hold nothing or everything',
    (maxEvents) => {
      expect(() => new EventQueue(maxEvents)).toThrow('maxEvents must be a positive integer')
    },
  )
})

/**
 * The server's schema takes `count` as an integer from 1 to 1,000,000, and refuses the whole batch
 * over one event outside that — so the queue never hands one out, however the run was built.
 */
const counts: Array<{ name: string; added: Array<number | undefined>; expected: number }> = [
  { name: 'an uncounted event is one', added: [undefined], expected: 1 },
  { name: 'a run that reaches the cap exactly', added: [999_999, 1], expected: 1_000_000 },
  { name: 'a run that passes the cap by one', added: [999_999, 1, 1], expected: 1_000_000 },
  { name: 'two counts that overflow together', added: [600_000, 600_000], expected: 1_000_000 },
  { name: 'a run already at the cap', added: [1_000_000, 1_000_000], expected: 1_000_000 },
  { name: 'a single count over the cap', added: [2_000_000], expected: 1_000_000 },
  { name: 'a count past the safe integers', added: [Number.MAX_VALUE], expected: 1_000_000 },
  { name: 'a zero count is one throw', added: [0], expected: 1 },
  { name: 'a negative count is one throw', added: [-5], expected: 1 },
  { name: 'a fractional count is one throw', added: [2.5], expected: 1 },
  { name: 'NaN is one throw', added: [Number.NaN], expected: 1 },
  { name: 'Infinity is one throw', added: [Number.POSITIVE_INFINITY], expected: 1 },
  { name: 'a bad count joining a run adds one', added: [3, Number.NaN, -2], expected: 5 },
]

describe('EventQueue counts', () => {
  it.each(counts)('$name', ({ added, expected }) => {
    const queue = new EventQueue(10)
    for (const count of added) {
      queue.add(count === undefined ? event('boom') : { ...event('boom'), count })
    }
    const drained = queue.drain()
    expect(drained).toHaveLength(1)
    expect(drained[0]!.count).toBe(expected)
    expect(Number.isInteger(drained[0]!.count)).toBe(true)
  })

  // The 50,000 of §8, pushed past the cap one throw at a time the way a hot loop would.
  it('never counts a run of single throws past the cap', () => {
    const queue = new EventQueue(10)
    queue.add({ ...event('boom'), count: 999_990 })
    const repeat = event('boom')
    for (let i = 0; i < 50_000; i += 1) queue.add(repeat)
    expect(repeat.count).toBeUndefined()
    expect(queue.drain()[0]!.count).toBe(1_000_000)
  })
})
