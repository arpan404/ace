/*
 * Gathering the FAQ page's questions from the lists other pages own. Pure, so the grouping in
 * content/questions.ts can be checked without a page.
 */

export interface Question {
  question: string;
  answer: string;
}

/** The entries of `list` asked as `wanted`, in `wanted`'s order; a missing one is an error. */
export function pick(list: readonly Question[], wanted: readonly string[]): Question[] {
  return wanted.map((text) => {
    const found = list.find((entry) => entry.question === text);
    if (!found) throw new Error(`No question "${text}" to put on the FAQ page`);
    return found;
  });
}

/**
 * Topics with any question already asked under an earlier topic (or earlier in the same one)
 * taken out, so a question shows once on the page and once in its FAQPage data.
 */
export function withoutRepeats<T extends { questions: readonly Question[] }>(
  topics: readonly T[],
): T[] {
  const asked = new Set<string>();
  return topics.map((topic) => ({
    ...topic,
    questions: topic.questions.filter((entry) => {
      if (asked.has(entry.question)) return false;
      asked.add(entry.question);
      return true;
    }),
  }));
}
