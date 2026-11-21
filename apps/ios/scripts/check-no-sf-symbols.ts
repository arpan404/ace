import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

/**
 * Fails when the iPhone app draws an SF Symbol. Every icon is ace's own (`AceIcon`, from
 * `@ace/icons`, the set the web draws); a missing one is added to `packages/icons` and
 * regenerated (`bun run icons` in apps/ios), never drawn from the system's set:
 *
 *   node apps/ios/scripts/check-no-sf-symbols.ts
 *
 * Only `allowed` may stay: places the system itself draws, which take nothing but a symbol name.
 */

/** One use of an SF Symbol in a Swift file. */
export interface SymbolUse {
  file: string;
  line: number;
  /** The call as written, `systemImage: "tray"`. */
  use: string;
}

/** Uses the system requires, by file and call, each with why no ace icon can stand in. */
export const allowed: readonly { file: string; use: string; why: string }[] = [
  {
    file: "apps/ios/Sources/Intents/StartThreadIntent.swift",
    use: 'systemImageName: "square.and.pencil"',
    why: "AppShortcut takes only a symbol name: Shortcuts and Spotlight draw it, not the app.",
  },
  {
    file: "apps/ios/Sources/Intents/StartThreadIntent.swift",
    use: 'systemImageName: "tray"',
    why: "AppShortcut takes only a symbol name: Shortcuts and Spotlight draw it, not the app.",
  },
];

const symbolCall = /\b(?:systemName|systemImage|systemImageName)\s*:\s*(?:"[^"]*"|[^,)\n]*)/g;

/** Where each string literal in a line starts and ends, and where its `//` comment begins. */
function scan(line: string): { strings: [number, number][]; comment: number } {
  const strings: [number, number][] = [];
  let open = -1;
  for (let i = 0; i < line.length; i += 1) {
    if (open >= 0 && line[i] === "\\") i += 1;
    else if (line[i] === '"') {
      if (open < 0) open = i;
      else {
        strings.push([open, i]);
        open = -1;
      }
    } else if (open < 0 && line.startsWith("//", i)) return { strings, comment: i };
  }
  return { strings, comment: line.length };
}

/** Every SF Symbol use in one Swift source, comments aside. */
export function symbolUses(file: string, source: string): SymbolUse[] {
  return source.split("\n").flatMap((text, index) => {
    const { strings, comment } = scan(text);
    return [...text.slice(0, comment).matchAll(symbolCall)]
      .filter((match) => !strings.some(([from, to]) => match.index > from && match.index < to))
      .map((match) => ({ file, line: index + 1, use: match[0].trim() }));
  });
}

/** The uses `allowed` doesn't list. */
export function disallowed(uses: readonly SymbolUse[]): SymbolUse[] {
  return uses.filter((use) => !allowed.some((a) => a.file === use.file && a.use === use.use));
}

if (import.meta.main) {
  const files = execFileSync("git", ["ls-files", "--", "apps/ios/*.swift"], { encoding: "utf8" })
    .trim()
    .split("\n")
    .filter(
      (file) =>
        file && !file.startsWith("apps/ios/Tests/") && !file.startsWith("apps/ios/UITests/"),
    );
  const uses = files.flatMap((file) => symbolUses(file, readFileSync(file, "utf8")));
  const bad = disallowed(uses);
  for (const use of bad) console.error(`${use.file}:${use.line}: ${use.use}`);
  if (bad.length > 0) {
    console.error(
      `${bad.length} SF Symbol use(s). Draw ace's own icon (AceIcon, Label(_:ace:), Button(_:ace:)); ` +
        "add a missing one to packages/icons and run `bun run icons` in apps/ios.",
    );
    process.exit(1);
  }
  console.log(`No SF Symbols in the iPhone app beyond the ${uses.length} allowed.`);
}
