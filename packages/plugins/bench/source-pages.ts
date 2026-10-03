import { performance } from "node:perf_hooks";
import { PluginService } from "../src/index.ts";
import { fixture, sampleFiles } from "../src/test-support.ts";

// Non-gating. Never run as part of checks; measurements belong to the merge rehearsal.
for (const kind of ["physical", "inline"] as const) {
  const text = "雪🙂 source page\n".repeat(4096);
  const f = await fixture(
    kind === "inline"
      ? {
          ".claude-plugin/plugin.json": JSON.stringify({
            name: "sample",
            commands: { hello: { content: text } },
          }),
        }
      : { ...sampleFiles, "commands/check.md": text },
  );
  try {
    await f.manager.accept(await f.prepare());
    const service = new PluginService(f.manager);
    await service.handle({ type: "plugins.catalog", offset: 0, limit: 50 });
    const path = kind === "inline" ? ".ace-inline/commands/hello.md" : "commands/check.md";
    const request = { type: "plugins.source", name: "sample", path, offset: 0, limit: 1024 };
    await service.handle(request);
    const count = 1000,
      started = performance.now();
    for (let index = 0; index < count; index++) await service.handle(request);
    const elapsed = performance.now() - started;
    console.log(
      JSON.stringify({
        operation: `plugin-${kind}-validated-source-page`,
        sourceBytes: Buffer.byteLength(text),
        pageBytes: 1024,
        opsPerSecond: (count * 1000) / elapsed,
        microsecondsPerOp: (elapsed * 1000) / count,
        peakRssBytes: process.resourceUsage().maxRSS * 1024,
      }),
    );
  } finally {
    await f.close();
  }
}
