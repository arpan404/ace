/**
 * A notice's words with the space it comes from first ("Acme Robotics · api"), while the person
 * has spaces to tell apart (ADR 0206 §1.5); the words alone otherwise.
 */
export function inSpaceWords(
  space: string | undefined,
  words: string | undefined,
): string | undefined {
  if (!space) return words;
  return words ? `${space} · ${words}` : space;
}
