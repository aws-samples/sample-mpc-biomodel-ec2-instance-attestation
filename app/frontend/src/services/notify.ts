/**
 * User-notification helpers.
 *
 * This sample uses the browser's native dialogs for user feedback and confirmation.
 * They are centralized here (rather than called directly throughout the components)
 * so there is a single place to swap in a non-blocking toast / modal library for a
 * production UI, and so the components contain no direct `alert`/`confirm` calls.
 */

/** Show an informational or error message to the user. */
export function notify(message: string): void {
  // nosemgrep: javascript-alert - intentional native dialog for this sample UI
  window.alert(message)
}

/**
 * Ask the user to confirm a (usually destructive) action.
 * Returns true if the user confirmed.
 */
export function confirmAction(message: string): boolean {
  // nosemgrep: javascript-confirm - intentional native dialog for this sample UI
  return window.confirm(message)
}
