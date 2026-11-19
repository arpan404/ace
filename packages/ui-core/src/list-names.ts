/** "A", "A and B", "A, B and C": names in a sentence. */
export function listNames(names: readonly string[]): string {
  return names.length <= 1
    ? (names[0] ?? "")
    : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

/** A bounded summary for directory rows and setting descriptions. */
export function summarizeNames(names: readonly string[]): string {
  return names.length <= 3
    ? listNames(names)
    : `${names.slice(0, 3).join(", ")} and ${names.length - 3} more`;
}
