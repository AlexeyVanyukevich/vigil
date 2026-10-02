import { useEffect, useState } from 'react'

/**
 * The current time, advancing every `intervalMs`, for screens that say how long ago something
 * happened.
 *
 * Reading `Date.now()` during render is not enough: nothing re-renders a screen whose data has not
 * changed — a refetch that returns the same answer keeps the same object — so "last seen 2m ago"
 * would still say so hours later, the wrong answer to "is it still happening". Thirty seconds is
 * finer than the minute the shortest label counts in.
 */
export function useNow(intervalMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs)
    return () => clearInterval(timer)
  }, [intervalMs])
  return now
}
