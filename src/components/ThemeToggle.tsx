import { useTheme } from '../theme/useTheme'

export function ThemeToggle() {
  const { theme, toggle } = useTheme()
  const isDark = theme === 'dark'

  return (
    <button
      type="button"
      className="theme-toggle"
      aria-label="Toggle theme"
      aria-pressed={theme === 'light'}
      title={isDark ? 'Switch to light theme' : 'Switch to dark theme'}
      onClick={toggle}
    >
      {isDark ? (
        // sun — shown when dark is active, click to go light
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" aria-hidden="true">
          <circle cx="12" cy="12" r="4.2" stroke="currentColor" strokeWidth="1.6" />
          <g stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
            <path d="M12 2.5v2.4" />
            <path d="M12 19.1v2.4" />
            <path d="M4.2 4.2l1.7 1.7" />
            <path d="M18.1 18.1l1.7 1.7" />
            <path d="M2.5 12h2.4" />
            <path d="M19.1 12h2.4" />
            <path d="M4.2 19.8l1.7-1.7" />
            <path d="M18.1 5.9l1.7-1.7" />
          </g>
        </svg>
      ) : (
        // moon — shown when light is active, click to go dark
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" aria-hidden="true">
          <path
            d="M20.5 14.6a8.6 8.6 0 1 1-9.1-12 7 7 0 0 0 9.1 12z"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinejoin="round"
          />
        </svg>
      )}
    </button>
  )
}
