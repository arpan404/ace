import { SuitId } from "@ace/protocol/suits";
import type { MarketProblem } from "@ace/protocol/marketplace";
import { inspectSuit, plan, type SuitEntry } from "@ace/suits/folder";
import type { ArchiveFile } from "../archive.ts";
import { previewBytes } from "../limits.ts";

/** A Suit's facts for its review: ADR 0150's static checks, its scenes and fonts. */
export interface SuitInspection {
  type: "suit";
  passes: boolean;
  problems: MarketProblem[];
  scenes: string[];
  fonts: string[];
}

/**
 * ADR 0150's static checks on a Suit folder from an archive: the same plan and inspection the
 * daemon's library runs on disk. The live check needs a rendered app and runs on the device.
 */
export function checkSuit(name: string, files: readonly ArchiveFile[]): SuitInspection {
  const problems: MarketProblem[] = [];
  if (!SuitId.safeParse(name).success)
    problems.push({ message: `${name} isn't a Suit id (lowercase words and dashes, at most 48)` });
  const own = files.filter((file) => file.path !== "market.json");
  const entries: SuitEntry[] = own.map((file) => ({
    path: file.path,
    kind: "file",
    size: file.content.byteLength,
  }));
  const walk = plan(entries);
  const read = new Set(walk.read);
  const bytes = new Map(
    own.filter((file) => read.has(file.path)).map((file) => [file.path, file.content]),
  );
  const inspected = inspectSuit(name, bytes, walk);
  for (const problem of inspected.summary.problems)
    problems.push({
      ...(problem.field && problem.field.includes(".") ? { path: problem.field } : {}),
      ...(problem.line ? { line: problem.line } : {}),
      message: `${problem.scheme ? `${problem.scheme}: ` : ""}${problem.message}`.slice(0, 500),
    });
  const preview = files.find((file) => file.path === "assets/preview.png");
  if (preview && preview.content.byteLength > previewBytes)
    problems.push({
      path: preview.path,
      message: `assets/preview.png is over ${previewBytes} bytes`,
    });
  const manifest = inspected.manifest;
  const scenes = manifest
    ? [
        ...(inspected.summary.scene ? ["app"] : []),
        ...Object.keys(manifest.scenes ?? {}).filter((region) => region !== "app"),
      ]
    : [];
  const fonts = Object.values(manifest?.fonts ?? {}).flatMap((font) =>
    font ? ["family" in font ? font.family : font.system] : [],
  );
  return {
    type: "suit",
    passes: problems.length === 0,
    problems,
    scenes: [...new Set(scenes)],
    fonts,
  };
}
