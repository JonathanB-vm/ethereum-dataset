/**
 * Shared timing for overlay exit animations (dictionary panel, row fullscreen, table
 * fullscreen). Exit animations need the element to stay *mounted* while they play, so
 * each owner holds a "closing" phase for this long before actually unmounting/unfixing.
 *
 * Keep in sync with the CSS: every `*-closing` animation in dictionary.css / table.css
 * runs 0.2s — the constant is the single source of truth for the JS half of that contract.
 */
export const EXIT_DURATION_MS = 200

function prefersReducedMotion(): boolean {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

/**
 * How long a closing overlay should stay mounted: 0 under reduced motion — the CSS
 * disables the animation there, so waiting would just delay the close for nothing.
 */
export function exitDuration(): number {
  return prefersReducedMotion() ? 0 : EXIT_DURATION_MS
}
