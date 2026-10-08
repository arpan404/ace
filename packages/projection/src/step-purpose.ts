/*
 * What a step is for, when ace recognises it from the command alone: a test run reads "Running
 * tests…" wherever a thread's status shows. Pure; shared by the daemon's live metadata and the
 * clients' live line, so the two never disagree.
 */

/** Test runners, invoked directly or through a package manager, build tool or interpreter. */
const testRun = new RegExp(
  [
    String.raw`\b(?:vitest|jest|mocha|ava|pytest|phpunit|rspec|ctest|nextest)\b`,
    String.raw`\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?test(?::\S*)?\b`,
    String.raw`\b(?:bun|deno|go|cargo|dotnet|swift|mix|zig)\s+test\b`,
    String.raw`\bplaywright\s+test\b`,
    String.raw`\bpython3?\s+-m\s+(?:pytest|unittest)\b`,
    String.raw`\b(?:mvn|mvnw|gradle|gradlew)\b.*\btest\b`,
    String.raw`\bmake\s+(?:test|check)\b`,
  ].join("|"),
);

/** Whether a shell command runs tests. */
export function isTestCommand(command: string): boolean {
  return testRun.test(command);
}
