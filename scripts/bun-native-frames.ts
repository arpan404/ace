/**
 * Bun writes frames of its built-in code as `native` (`at native`, `at map (native:1:11)`).
 * Vitest resolves that name against the working directory to look for a source map, and in
 * this repository that is the `native/` folder: reading it fails with EISDIR and the run reports
 * an unhandled error. Under Bun, test isolates leave those frames out of their stacks.
 */
export function dropNativeFrames(): void {
  if (!process.versions.bun) return;
  const format = Error.prepareStackTrace;
  if (!format) return;
  Error.prepareStackTrace = (error, sites) =>
    format(
      error,
      sites.filter((site) => site.getFileName() !== "native" && !site.isNative()),
    );
}
