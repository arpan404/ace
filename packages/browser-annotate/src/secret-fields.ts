/**
 * Form fields whose contents agents never see in images or snapshots (ADR 0067, Privacy): password
 * fields, including ones a page switched to plain text to "show" the password (they keep their
 * password autocomplete token), one-time codes and card numbers and codes. Shared by the page
 * overlay that masks them in captures and the daemon that blanks them in snapshots.
 */
export const secretFieldSelector = [
  'input[type="password" i]',
  'input[autocomplete~="current-password" i]',
  'input[autocomplete~="new-password" i]',
  'input[autocomplete~="one-time-code" i]',
  'input[autocomplete~="cc-number" i]',
  'input[autocomplete~="cc-csc" i]',
].join(", ");

/** What a snapshot shows instead of a secret field's value, whatever its length. */
export const maskedSecretValue = "••••••••";
