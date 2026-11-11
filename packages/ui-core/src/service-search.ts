/*
 * Narrowing a long list of sign-in services (OpenCode offers about 240) to what the person types.
 * Pure: every client filters the same way.
 */

/** The fallback choice ("Another provider or an API key") stays offered whatever is typed. */
const fallback = "other";

/**
 * The choices whose name or id holds every typed word, in their given order. An empty search
 * keeps them all; the fallback choice is always kept.
 */
export function matchingServices<T extends { id: string; label: string }>(
  choices: readonly T[],
  query: string,
): T[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [...choices];
  return choices.filter((choice) => {
    if (choice.id === fallback) return true;
    const text = `${choice.label} ${choice.id}`.toLowerCase();
    return words.every((word) => text.includes(word));
  });
}
