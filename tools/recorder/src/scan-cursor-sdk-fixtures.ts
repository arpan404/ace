import { readdir, readFile } from "node:fs/promises";
import { userInfo } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { isSensitiveField } from "@ace/redaction";
import { readFixture, replayFixture } from "@ace/adapter-testkit";
import { createCursorAdapter } from "@ace/adapter-cursor";

// Offline only. Never opens a provider, authenticates, or reads an SDK store.
const root = "fixtures/cursor-sdk/1.0.35/composer-2.5";
const owner = userInfo().username.toLowerCase();
const patterns = [
  [
    "credential",
    /\b(?:sk-|gh[opsur]_|github_pat_|xox[baprs]-|AKIA|AIza)[A-Za-z0-9_-]{12,}|\bnpm_[A-Za-z0-9]{20,}|\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}|(?:Bearer|Basic)\s+[A-Za-z0-9+/=._-]{8,}/i,
  ],
  ["email", /(?<![A-Za-z0-9._%+-])[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/],
  ["absolute-home", /\/(?:Users|home)\/|\/root\/|[A-Za-z]:[\\/]+Users[\\/]/],
] as const;
const findings: { file: string; category: string; line?: number }[] = [];
const lexical = (value: string, file: string, line?: number) => {
  for (const [category, pattern] of patterns)
    if (
      pattern.test(
        value
          .replaceAll("recorder@ace.invalid", "<SYNTHETIC>")
          .replaceAll("noreply@anthropic.com", "<PROVIDER>"),
      )
    )
      findings.push({ file, category, ...(line === undefined ? {} : { line }) });
  if (value.toLowerCase().includes(owner))
    findings.push({ file, category: "owner-username", ...(line === undefined ? {} : { line }) });
};
const scan = (value: unknown, file: string, line?: number, structured = true): void => {
  if (typeof value === "string") lexical(value, file, line);
  else if (Array.isArray(value)) for (const item of value) scan(item, file, line, structured);
  else if (value && typeof value === "object")
    for (const [key, item] of Object.entries(value)) {
      if (structured && item !== null && item !== "<SECRET>" && isSensitiveField(key, item))
        findings.push({
          file,
          category: "unredacted-sensitive-field",
          ...(line === undefined ? {} : { line }),
        });
      lexical(key, file, line);
      scan(item, file, line, structured);
    }
};
for (const name of (await readdir(root)).toSorted()) {
  const text = await readFile(join(root, name), "utf8");
  for (const [i, line] of text.split("\n").entries()) lexical(line, name, i + 1);
  if (name.endsWith(".jsonl")) {
    for (const [i, line] of text.split("\n").entries())
      if (line.trim()) {
        const value: unknown = JSON.parse(line);
        scan(value, name, i + 1);
      }
    const fixture = await readFixture(join(root, name));
    for (const [threadId, frames] of Object.entries(
      fixture.threads ?? { "replay-thread": fixture.frames },
    )) {
      const result = replayFixture({
        fixture: { ...fixture, frames },
        threadId,
        createTranslator: createCursorAdapter().createTranslator,
        coreConfig: { provider: "cursor", silenceMs: 90000 },
      });
      // Scan reassembled fragments as well as individual capture rows.
      scan(Object.values(result.final.view.items), name, undefined, false);
    }
  } else if (name.endsWith(".json")) {
    const value: unknown = JSON.parse(text);
    scan(value, name);
  }
  console.log(
    JSON.stringify({ file: name, sha256: createHash("sha256").update(text).digest("hex") }),
  );
}
console.log(JSON.stringify({ privacyFindings: findings }));
if (findings.length) process.exitCode = 1;
