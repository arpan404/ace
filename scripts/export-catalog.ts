// SPDX-License-Identifier: Apache-2.0

/**
 * The MCP catalog, exported once (M1): every tool's descriptor, the public error catalog, the
 * server instructions, guide topics, session guidance, control hints and listing headers, as
 * `JSON.stringify` writes them, into `native/daemon/catalog/`.
 *
 * The words and descriptors are authored here, by the TypeScript that runs today; the Rust
 * server embeds the same files (`ace-mcp/src/catalog.rs`). `--check` re-exports and fails when
 * a committed file differs, so a changed word or listing rule is a catalog edit both sides see.
 *
 * Nothing here starts a provider, a browser or a device: every value is the static catalog.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ProviderKind } from "../packages/protocol/src/index.ts";
import {
  agentControlToolCatalog,
  aceInstructions,
  advertisedInputSchema,
  advertisedOutputSchema,
  builtinToolCatalog,
  codexClientHeader,
  contextToolCatalog,
  controlHints,
  coreToolsHeader,
  cursorClientHeader,
  developerInstructions,
  geminiUntrustedGuidance,
  guideTopics,
  handoffToolCatalog,
  htmlToolCatalog,
  imageToolCatalog,
  knowledgeToolCatalog,
  metaToolCatalog,
  publicErrorCatalog,
  PublicToolCode,
  staticToolsHeader,
  suitToolCatalog,
  toolFamilies,
  usualToolListing,
} from "../packages/mcp-server/src/index.ts";
import { z } from "zod";

const root = fileURLToPath(new URL("../", import.meta.url));
const directory = join(root, "native/daemon/catalog");

/** The catalog arrays the server registers, in one fixed order. */
const catalogs = [
  metaToolCatalog,
  builtinToolCatalog,
  handoffToolCatalog,
  agentControlToolCatalog,
  knowledgeToolCatalog,
  contextToolCatalog,
  imageToolCatalog,
  htmlToolCatalog,
  suitToolCatalog,
];

type Entry = Record<string, unknown>;

/** One tool's descriptor: its identity, its words, and the schemas a model reads. */
function descriptor(entry: Entry): Entry {
  const input = entry.input as z.ZodType;
  const output = entry.output as z.ZodType | undefined;
  return {
    name: entry.name,
    title: entry.title,
    toolset: entry.toolset,
    riskClass: entry.riskClass,
    ...(entry.openWorld === undefined ? {} : { openWorld: entry.openWorld }),
    description: entry.description,
    ...(entry.capability === undefined ? {} : { capability: entry.capability }),
    ...(entry.timeoutMs === undefined ? {} : { timeoutMs: entry.timeoutMs }),
    input: advertisedInputSchema({ ...z.toJSONSchema(input, { io: "input" }), type: "object" }),
    ...(output === undefined
      ? {}
      : {
          output: advertisedOutputSchema({
            ...z.toJSONSchema(output, { io: "output" }),
            type: "object",
          }),
        }),
  };
}

/** Every descriptor once, by name, in a stable order. A name listed twice is a catalog bug. */
function tools(): Entry[] {
  const byName = new Map<string, Entry>();
  for (const catalog of catalogs)
    for (const entry of catalog as readonly Entry[]) {
      const name = entry.name as string;
      if (byName.has(name)) throw new Error(`catalog: ${name} is registered twice`);
      byName.set(name, descriptor(entry));
    }
  return [...byName.values()].toSorted((a, b) =>
    (a.name as string).localeCompare(b.name as string),
  );
}

const files: Record<string, unknown> = {
  "tools.json": { tools: tools() },
  "errors.json": { codes: PublicToolCode.options, catalog: publicErrorCatalog },
  "instructions.json": {
    guideTopics,
    toolFamilies,
    instructions: aceInstructions,
  },
  "control-hints.json": controlHints,
  "session-guidance.json": {
    providers: Object.fromEntries(
      ProviderKind.options.map((provider) => [
        provider,
        { listing: usualToolListing(provider), developer: developerInstructions(provider) },
      ]),
    ),
    geminiUntrusted: geminiUntrustedGuidance("/tmp/project", false),
  },
  "listing-headers.json": {
    core: coreToolsHeader,
    static: staticToolsHeader,
    clients: { codex: codexClientHeader, cursor: cursorClientHeader },
  },
};

const check = process.argv.includes("--check");
mkdirSync(directory, { recursive: true });
let failed = 0;
for (const [name, value] of Object.entries(files)) {
  const text = `${JSON.stringify(value, null, 2)}\n`;
  const path = join(directory, name);
  if (check) {
    const committed = (() => {
      try {
        return readFileSync(path, "utf8");
      } catch {
        return undefined;
      }
    })();
    if (committed !== text) {
      console.error(
        `catalog: ${name} is not what the TypeScript writes; run bun run catalog:export`,
      );
      failed++;
    }
  } else {
    writeFileSync(path, text);
  }
}
if (check && failed > 0) process.exit(1);
