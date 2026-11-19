/**
 * The spellchecker's one language. macOS checks with the system's own spellchecker and ignores
 * this. On Windows and Linux Chromium loads a dictionary for each language it is given (Linux
 * downloads each Hunspell one), so the page gets only the person's first system language that
 * Chromium has one for, matched exactly (`en-GB`) and then by language (`en`). None: `en-US`.
 */
export function spellcheckLanguages(
  preferred: readonly string[],
  available: readonly string[],
): string[] {
  const byLowercase = new Map(available.map((code) => [code.toLowerCase(), code]));
  for (const locale of preferred) {
    const exact = byLowercase.get(locale.toLowerCase());
    if (exact) return [exact];
    const language = locale.split("-")[0]?.toLowerCase();
    const match = available.find(
      (code) => code.toLowerCase() === language || code.toLowerCase().startsWith(`${language}-`),
    );
    if (match) return [match];
  }
  return available.includes("en-US") ? ["en-US"] : [];
}
