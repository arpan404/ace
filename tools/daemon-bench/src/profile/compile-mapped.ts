/**
 * Builds the release daemon bundle exactly as `apps/daemon/bench/compile.ts --cli` does, plus
 * external source maps, so CPU profiles of the minified bundle can be attributed to source
 * files. The generated code is byte-identical apart from a trailing sourceMappingURL comment,
 * which Node ignores without `--enable-source-maps`.
 *
 * node tools/daemon-bench/src/profile/compile-mapped.ts --output=DIR
 */
import { registerHooks } from "node:module";

registerHooks({
  load(url, context, nextLoad) {
    const result = nextLoad(url, context);
    if (!url.endsWith("/tools/release/src/bundle.ts")) return result;
    const source = String(result.source);
    const patched = source.replace("minify: true,", 'minify: true, sourcemap: "linked",');
    if (patched === source) throw new Error("bundle.ts no longer has `minify: true,`");
    return { ...result, source: patched };
  },
});
if (!process.argv.includes("--cli")) process.argv.push("--cli");
await import("../../../../apps/daemon/bench/compile.ts");
