export function promptProblem(message: string): string {
  return message === "Invalid command metadata or document"
    ? "The settings or arguments at the top of this prompt couldn't be read. Check the names and indentation."
    : message;
}
