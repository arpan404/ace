/*
 * The appearances screenshots and checks run under. An id is a mode ("light", "dark") for the
 * default theme, or "<theme>-<mode>" for another theme; specs store it in the app's own shape
 * (`ace.appearance`, mode separate from theme): `{ mode }` or `{ theme, mode }`.
 */

/** Light and dark, then a spread of themes across both modes. */
export const screenThemes = [
  "light",
  "dark",
  "folio-light",
  "umbra-dark",
  "signal-dark",
  "tty-dark",
  "harbor-light",
] as const;
