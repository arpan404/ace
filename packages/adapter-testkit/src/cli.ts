import { parseArgs } from "node:util";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { ProviderKind } from "@ace/protocol";
import type { ProviderAdapter } from "@ace/engine-api";
import { readFixture } from "./fixture.ts";
import { readExpectations } from "./expectations.ts";
import { replayFixture } from "./replay.ts";

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      adapter: { type: "string" },
      expect: { type: "string" },
      checkpoint: { type: "string", multiple: true },
      "silence-ms": { type: "string", default: "90000" },
      "root-key": { type: "string", default: "root" },
    },
  });
  const [path] = positionals;
  if (!path || positionals.length !== 1 || !values.adapter)
    throw new Error(
      "usage: timeline <fixture> --adapter <module> [--expect <file>] [--checkpoint <ms>]",
    );
  const specifier =
    values.adapter.startsWith(".") || values.adapter.startsWith("/")
      ? pathToFileURL(resolve(values.adapter)).href
      : values.adapter;
  // Adapter modules export a default ProviderAdapter, or a named `adapter`.
  const loaded: { default?: ProviderAdapter; adapter?: ProviderAdapter } = await import(specifier);
  const adapter = loaded.default ?? loaded.adapter;
  if (!adapter || typeof adapter.createTranslator !== "function")
    throw new Error(`${values.adapter} must export a default ProviderAdapter or named adapter`);
  const fixture = await readFixture(path);
  if (fixture.header.provider !== adapter.provider)
    throw new Error(
      `fixture provider ${fixture.header.provider} does not match adapter ${adapter.provider}`,
    );
  const expectations = values.expect ? await readExpectations(values.expect) : undefined;
  const result = replayFixture({
    createTranslator: (init) => adapter.createTranslator(init),
    fixture,
    coreConfig: {
      provider: ProviderKind.parse(adapter.provider),
      silenceMs: Number(values["silence-ms"]),
    },
    rootKey: values["root-key"],
    checkpoints: [
      ...(expectations?.checkpoints.map((point) => point.t) ?? []),
      ...(values.checkpoint ?? []).map(Number),
    ],
  });
  for (const entry of result.timeline) console.log(JSON.stringify(entry));
  const { view: _view, ...summary } = result.final;
  console.log(JSON.stringify({ final: summary }));
}
main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
