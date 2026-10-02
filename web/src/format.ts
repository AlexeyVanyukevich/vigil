const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

/**
 * "2h ago" rather than a timestamp, because the only question the list answers is whether
 * something is still happening. The exact time is on the detail screen, where it matters.
 *
 * `now` is required, not defaulted to `Date.now()`: a screen passes `useNow()`, which advances on
 * its own, and a default would let one forget and freeze at the moment it rendered.
 */
export function relativeTime(iso: string, now: number): string {
  const then = new Date(iso).getTime()
  if (Number.isNaN(then)) return 'unknown'

  const elapsed = now - then
  if (elapsed < 0) return 'just now'
  if (elapsed < MINUTE) return 'just now'
  if (elapsed < HOUR) return `${Math.floor(elapsed / MINUTE)}m ago`
  if (elapsed < DAY) return `${Math.floor(elapsed / HOUR)}h ago`
  if (elapsed < 30 * DAY) return `${Math.floor(elapsed / DAY)}d ago`
  return new Date(then).toISOString().slice(0, 10)
}

/**
 * §11: node_modules frames are collapsed. They are still there — a stack with holes in it is
 * worse than a long one — but folded and dimmed, so the eye lands on the owner's own code.
 *
 * The first line is the error itself, never a frame, whatever path its message happens to name.
 */
export function splitFrames(stack: string): Array<{ text: string; vendor: boolean }> {
  return stack.split(/\r?\n/).map((text, index) => ({
    text,
    vendor: index > 0 && /[/\\]node_modules[/\\]/.test(text),
  }))
}

/** Consecutive frames of the same kind, so each stretch of dependency frames folds as one. */
export function frameRuns(stack: string): Array<{ vendor: boolean; frames: string[] }> {
  const runs: Array<{ vendor: boolean; frames: string[] }> = []
  for (const frame of splitFrames(stack)) {
    const last = runs.at(-1)
    if (last !== undefined && last.vendor === frame.vendor) last.frames.push(frame.text)
    else runs.push({ vendor: frame.vendor, frames: [frame.text] })
  }
  return runs
}
