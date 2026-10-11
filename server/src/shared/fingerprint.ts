import { createHash } from 'node:crypto'

export interface Frame {
  /** The function or method, `<anonymous>` when the stack gave none. */
  fn: string
  /** The file or URL, with line and column removed. */
  module: string
  /** A dependency's frame: kept, but never preferred as the culprit. */
  vendor: boolean
}

/**
 * Enough frames to tell two call paths apart, few enough that a deeper stack reaching the same
 * throw site through one more wrapper stays one issue.
 */
const FRAMES_IN_FINGERPRINT = 5

// `    at fn (/path/file.js:10:15)` — the common V8 shape.
const FRAME_WITH_FN = /^\s*at\s+(.+?)\s+\((.+?)\)\s*$/
// `    at /path/file.js:10:15` — a top-level frame with no function.
const FRAME_BARE = /^\s*at\s+(.+?)\s*$/
// A trailing `:line:column`, or `:line` alone.
const POSITION = /:\d+(?::\d+)?$/
const DECORATION = /^(?:async|new)\s+/
const VENDOR = /[/\\]node_modules[/\\]/

const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi
const HEX = /\b[0-9a-f]{16,}\b/gi
const DIGITS = /\b\d+\b/g

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function toFrame(fn: string, location: string): Frame {
  const name = fn.replace(DECORATION, '').trim()
  // `file://` and a query string are transport, not identity: the same module reached two ways
  // must not become two issues.
  const module = location
    .replace(POSITION, '')
    .replace(/^file:\/\//, '')
    .replace(/[?#].*$/, '')
  return {
    fn: name === '' ? '<anonymous>' : name,
    module,
    vendor: VENDOR.test(module),
  }
}

export function parseFrames(stack: string): Frame[] {
  const frames: Frame[] = []

  for (const line of stack.split('\n')) {
    const withFn = FRAME_WITH_FN.exec(line)
    if (withFn?.[1] !== undefined && withFn[2] !== undefined) {
      frames.push(toFrame(withFn[1], withFn[2]))
      continue
    }

    const bare = FRAME_BARE.exec(line)
    const location = bare?.[1]
    // A location has a path separator. `at Object.<anonymous>` has only a dot, and treating it
    // as a module would put a function name where a file belongs.
    if (location !== undefined && (location.includes('/') || location.includes('\\'))) {
      frames.push(toFrame('<anonymous>', location))
    }
  }

  return frames
}

/**
 * Order matters. A UUID contains digit runs and a hex run, so replacing digits first would
 * shred it into placeholders that no longer match another UUID's.
 */
export function normalizeMessage(message: string): string {
  return message.replace(UUID, '<uuid>').replace(HEX, '<hex>').replace(DIGITS, '<n>').trim()
}

export interface FingerprintInput {
  /** The error's constructor name — `TypeError`, `Error`, or whatever the thrower called it. */
  type: string
  message: string
  stack?: string | undefined
  /** The client's escape hatch (§7). Overrides everything else. */
  fingerprint?: string | undefined
}

export interface Fingerprinted {
  fingerprint: string
  culprit: string | null
}

function describe(frame: Frame | undefined): string | null {
  return frame === undefined ? null : `${frame.fn} (${frame.module})`
}

export function fingerprintOf(input: FingerprintInput): Fingerprinted {
  const frames = input.stack === undefined ? [] : parseFrames(input.stack)
  const own = frames.filter((frame) => !frame.vendor)

  // The owner's code names the issue. With none — an error thrown wholly inside a dependency —
  // the top frame is all there is, and it is better than nothing.
  const culprit = describe(own[0] ?? frames[0])

  const explicit = input.fingerprint?.trim()
  if (explicit !== undefined && explicit !== '') {
    // Tagged with a literal `'explicit'` first element that the computed path's `'computed'`
    // tag can never produce: JSON.stringify encodes the tag as the array's first quoted
    // element, so the two arrays diverge in their first bytes no matter what `explicit`,
    // `type` or `body` contain. A text prefix cannot promise that — `type` is wire-controlled,
    // and `${type}\n${body}` can be made to start with the same bytes as `explicit\n${value}`.
    return { fingerprint: sha256(JSON.stringify(['explicit', explicit])), culprit }
  }

  // Vendor frames are skipped so a dependency upgrade does not split every issue in the
  // project. When they are all there is, they are used rather than hashing the type alone.
  const chosen = (own.length > 0 ? own : frames).slice(0, FRAMES_IN_FINGERPRINT)

  const body =
    chosen.length > 0
      ? chosen.map((frame) => `${frame.fn}@${frame.module}`).join('\n')
      : normalizeMessage(input.message)

  return { fingerprint: sha256(JSON.stringify(['computed', input.type, body])), culprit }
}
