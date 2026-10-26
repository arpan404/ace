import type { Rolldown } from "vite";

type ChunkGroup = Exclude<NonNullable<Rolldown.OutputOptions["codeSplitting"]>, boolean>["groups"];

/**
 * Phosphor icons that five or more lazy pages share, as one lazy chunk (about 55 KB gzip).
 *
 * Left to automatic chunking, each icon shared by several pages became a chunk of its own: over
 * 110 files of 1–3 KB, enough to push the daemon release past the installed updater's
 * 2,048-entry archive budget (`packages/service/src/artifact.ts`; old apps keep that limit, so it
 * can't be raised here). Icons fewer pages share stay with them: gathering every icon made the
 * thread and New thread pages load ~15–37 KB gzip of icons they never draw (bundle budgets in
 * `tools/web-perf`).
 *
 * The group sits after the initial group at the same priority, so an icon the first paint uses
 * stays in the initial chunk; only the lazy remainder is gathered here.
 */
export function lazyIconChunk(): NonNullable<ChunkGroup>[number] {
  return {
    debugName: "icons",
    includeDependenciesRecursively: false,
    minShareCount: 5,
    test: /[\\/]node_modules[\\/]@phosphor-icons[\\/]react[\\/]/,
    name: "icons",
  };
}
