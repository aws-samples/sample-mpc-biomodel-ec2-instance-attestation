/**
 * Parse a backend timestamp into a Date, correctly.
 *
 * The backend emits `datetime.utcnow().isoformat()`, which produces a timezone-NAIVE
 * string like "2026-07-27T15:58:41.620209" (no trailing Z / offset). `new Date(...)`
 * on such a string interprets it as LOCAL time, so a UTC instant gets relabeled into
 * the local zone and displays off by the local UTC offset. Treat a timezone-less
 * timestamp as UTC by appending 'Z'; leave already-zoned strings untouched.
 */
export function parseBackendDate(value: string): Date {
  if (!value) return new Date(NaN)
  const hasTz = /[zZ]$/.test(value) || /[+-]\d{2}:?\d{2}$/.test(value)
  return new Date(hasTz ? value : `${value}Z`)
}

/** Format a backend timestamp as a localized date+time string. */
export function formatBackendDateTime(value: string): string {
  const d = parseBackendDate(value)
  return isNaN(d.getTime()) ? '—' : d.toLocaleString()
}

/** Format a backend timestamp as a localized date-only string. */
export function formatBackendDate(value: string): string {
  const d = parseBackendDate(value)
  return isNaN(d.getTime()) ? '—' : d.toLocaleDateString()
}
