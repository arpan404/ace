/**
 * Up to two initials for a person's display name, for the account disc: "Arpan Bhandari" → "AB",
 * "ada" → "A", "  " → "". Letters are taken from the first and last words, upper-cased.
 */
export function initials(name: string): string {
  const words = name.trim().split(/\s+/u).filter(Boolean);
  const first = words[0];
  if (!first) return "";
  const last = words.length > 1 ? words.at(-1) : undefined;
  const letter = (word: string) => (Array.from(word)[0] ?? "").toLocaleUpperCase();
  return letter(first) + (last ? letter(last) : "");
}
