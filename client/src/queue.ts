import { collapseKey, LIMITS, type WireEvent } from './payload.js'

/**
 * What one event stands for, as the server will accept it: an integer from 1 to
 * `LIMITS.countMax`. Anything else is one throw, because it was at least that. A count over the cap
 * is held at the cap — the server refuses the whole batch over one event past it.
 */
function occurrences(count: number | undefined): number {
  if (count === undefined || !Number.isInteger(count) || count < 1) return 1
  return Math.min(count, LIMITS.countMax)
}

/**
 * Bounded and collapsing, because a monitoring client's characteristic failure is that it
 * damages the application it watches (§8).
 *
 * The bound counts *distinct* failures. A loop throwing one error a hundred thousand times
 * occupies one slot, which is what stops the first real incident from being the thing that
 * exhausts the host's heap.
 */
export class EventQueue {
  /** Insertion-ordered by construction, which is what makes drop-oldest a `keys()` read. */
  private readonly events = new Map<string, WireEvent>()
  private droppedCount = 0

  constructor(private readonly maxEvents: number) {
    if (!Number.isInteger(maxEvents) || maxEvents < 1) {
      throw new Error('maxEvents must be a positive integer')
    }
  }

  get dropped(): number {
    return this.droppedCount
  }

  add(event: WireEvent): void {
    const key = collapseKey(event)
    const existing = this.events.get(key)

    if (existing !== undefined) {
      // The first timestamp is kept: it is when the run started, and a run that has been going
      // for five minutes should not look like it started a moment ago. A run past the cap stops
      // counting there; one event cannot say more, and see docs/backlog.md.
      existing.count = Math.min(
        occurrences(existing.count) + occurrences(event.count),
        LIMITS.countMax,
      )
      // Moved to newest, so eviction follows the last sighting: a failure still recurring is what
      // is happening now, and must not be dropped for one-offs that arrived after it first did.
      this.events.delete(key)
      this.events.set(key, existing)
      return
    }

    if (this.events.size >= this.maxEvents) {
      // Oldest first. What is happening now is what the owner will be asked about.
      const oldest = this.events.keys().next()
      if (!oldest.done) {
        this.events.delete(oldest.value)
        this.droppedCount += 1
      }
    }

    this.events.set(key, { ...event, count: occurrences(event.count) })
  }

  size(): number {
    return this.events.size
  }

  drain(): WireEvent[] {
    const drained = [...this.events.values()]
    this.events.clear()
    return drained
  }
}
