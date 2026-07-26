import { useEffect, useState } from 'react'

/**
 * Trailing-edge debounce. Global search runs a substring match across 34 fields of every
 * loaded record — ~2.5M string operations per keystroke on the 74,889-row dataset — so the
 * input keeps its own immediate state and the *table* consumes this delayed value.
 */
export function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value)

  useEffect(() => {
    const id = window.setTimeout(() => setDebounced(value), delayMs)
    return () => window.clearTimeout(id)
  }, [value, delayMs])

  return debounced
}
