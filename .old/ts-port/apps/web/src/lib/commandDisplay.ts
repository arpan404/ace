export function formatCommandDisplayLabel(name: string): string {
  const formattedWords: string[] = [];
  for (const word of name
    .trim()
    .replace(/^[/@$]+/, "")
    .split(/[-_.:\s/]+/u)) {
    if (word.length === 0) {
      continue;
    }
    formattedWords.push(word.charAt(0).toUpperCase() + word.slice(1));
  }
  return formattedWords.join(" ");
}
