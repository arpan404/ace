/** Owned native fixture only. Measures reads, verifies a test-field edit, then restores it. */
import { spawn } from "node:child_process";
import { randomUUID, createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import { z } from "zod";
import { CredentialRegistry, ToolRegistry } from "@ace/mcp-server";
import { McpScope } from "@ace/protocol";
import { ComputerClient, computerToolkit } from "../src/index.ts";

const config = z
  .object({
    before: z.string().min(1),
    after: z.string().min(1),
    app: z.string().min(1),
    rounds: z.coerce.number().int().min(2).max(100).default(12),
  })
  .parse({
    before: process.env["ACE_CU_BASELINE_HELPER"],
    after: process.env["ACE_COMPUTER_HELPER"],
    app: process.env["ACE_CU_BENCH_APP"],
    rounds: process.env["ACE_CU_BENCH_ROUNDS"],
  });
if (!config.app.startsWith("dev.ace.query-fixture-"))
  throw new Error("Use an owned query fixture, never a person's app");

function world(helper: string) {
  let received = 0;
  const client = new ComputerClient({
    helper: async () => helper,
    nextId: randomUUID,
    spawnHelper(command, args) {
      const child = spawn(command, [...args], { stdio: ["pipe", "pipe", "pipe"] });
      child.stdout.on("data", (chunk: Buffer) => {
        received += chunk.length;
      });
      return child;
    },
  });
  const registry = new ToolRegistry({ scheduler: { after: () => () => {} } });
  computerToolkit(client).register(registry);
  const credentials = new CredentialRegistry(() => "b".repeat(64));
  const lease = credentials.issue(
    McpScope.parse({
      sessionId: "bench",
      threadId: "bench",
      agentId: "root",
      capabilities: ["screen"],
    }),
    new AbortController().signal,
  );
  return {
    client,
    async look(args: Record<string, unknown>) {
      const bytes = received;
      const start = performance.now();
      const result = await registry.call(
        "screen_state",
        { app: config.app, ...args },
        lease.principal,
        new AbortController().signal,
      );
      const ms = performance.now() - start;
      const text = result.content
        .flatMap((part) => (part.type === "text" ? [part.text] : []))
        .join("\n");
      if (result.isError) throw new Error(text);
      const picture = result.content.find((part) => part.type === "image");
      return {
        text,
        ms,
        bytes: received - bytes,
        pictureHash:
          picture?.type === "image"
            ? createHash("sha256").update(picture.data).digest("hex")
            : undefined,
      };
    },
    close() {
      client.close();
      credentials.close();
    },
  };
}

const percentile = (values: number[], fraction: number) =>
  values.toSorted((a, b) => a - b)[
    Math.min(values.length - 1, Math.floor(values.length * fraction))
  ] ?? 0;
const summarize = (values: { ms: number; bytes: number }[]) => ({
  p50Ms: percentile(
    values.map((value) => value.ms),
    0.5,
  ),
  p95Ms: percentile(
    values.map((value) => value.ms),
    0.95,
  ),
  medianReplyBytes: percentile(
    values.map((value) => value.bytes),
    0.5,
  ),
});
const queries = ["target invoice", "Value: row 2", "text field", "missing record", "İ"];
const results: Record<string, { query: string; text: string; ms: number; bytes: number }[]> = {};
const screenshots: Record<
  string,
  { text: string; ms: number; bytes: number; pictureHash?: string | undefined }[]
> = {};
const NodeCounts = z.object({
  nodes: z.array(z.object({ id: z.number(), value: z.string().optional() })),
  app: z.object({ active: z.boolean().optional() }),
  truncated: z.boolean().optional(),
  notResponding: z.boolean().optional(),
  searchFiltered: z.boolean().optional(),
});
const Batch = z.object({ done: z.array(z.string()), error: z.unknown().optional() });
const firstSearchMs: Record<string, number> = {};

for (const [label, helper] of [
  ["before", config.before],
  ["after", config.after],
]) {
  if (!label || !helper) throw new Error("Missing comparison helper");
  const made = world(helper);
  try {
    let initial = await made.look({ full: true });
    const readyBy = performance.now() + 5_000;
    while (!initial.text.includes("target invoice record") && performance.now() < readyBy) {
      await new Promise<void>((resolve) => setTimeout(resolve, 50));
      initial = await made.look({ full: true });
    }
    if (!initial.text.includes("target invoice record"))
      throw new Error("Use the owned search fixture; target content is unavailable");
    const full = NodeCounts.parse(await made.client.request("state", { app: config.app }));
    if (full.nodes.length < 20)
      throw new Error("The fixture did not expose enough controls to benchmark search");
    if (full.truncated || full.notResponding || full.app.active)
      throw new Error("The owned fixture must expose a full tree and stay in the background");
    const fullIDs = JSON.stringify(full.nodes.map((node) => node.id));
    firstSearchMs[label] = (await made.look({ find: "target invoice" })).ms;
    const futureFormat = NodeCounts.parse(
      await made.client.request("state", {
        app: config.app,
        find: "missing record",
        findFormat: 999,
      }),
    );
    if (
      JSON.stringify(futureFormat.nodes.map((node) => node.id)) !== fullIDs ||
      futureFormat.searchFiltered
    )
      throw new Error("Unknown search format discarded controls");
    const values: (typeof results)[string] = [];
    results[label] = values;
    for (const query of queries) {
      await made.look({ find: query });
      for (let round = 0; round < config.rounds; round++)
        values.push({ query, ...(await made.look({ find: query })) });
    }
    await made.look({ outline: false });
    const pictures: (typeof screenshots)[string] = [];
    screenshots[label] = pictures;
    for (let round = 0; round < config.rounds; round++)
      pictures.push(await made.look({ outline: false }));
    const retained = NodeCounts.parse(await made.client.request("state", { app: config.app }));
    if (JSON.stringify(retained.nodes.map((node) => node.id)) !== fullIDs || retained.app.active)
      throw new Error("Search lost controls or activated the fixture");
    const target = retained.nodes.find((node) => node.value === "target invoice record");
    if (!target) throw new Error("Owned test field missing");
    const setValue = async (value: string) => {
      const result = Batch.parse(
        await made.client.request("act", {
          app: config.app,
          actions: [{ type: "set_value", id: target.id, value }],
          observe: false,
        }),
      );
      if (result.error !== undefined || result.done.length !== 1)
        throw new Error("Owned test edit failed");
    };
    try {
      await setValue("ace refreshed search value");
      const old = await made.look({ find: "target invoice" });
      const fresh = await made.look({ find: "ace refreshed search value" });
      if (
        !old.text.includes("Nothing in the window matches") ||
        !fresh.text.includes("Value: ace refreshed search value")
      )
        throw new Error("Search reused stale content after editing");
    } finally {
      await setValue("target invoice record");
    }
    const restored = NodeCounts.parse(await made.client.request("state", { app: config.app }));
    if (
      !restored.nodes.some((node) => node.value === "target invoice record") ||
      restored.app.active
    )
      throw new Error("Fixture restore or background isolation failed");
  } finally {
    made.close();
  }
}

const report = queries.map((query) => {
  const before = results["before"]?.filter((result) => result.query === query) ?? [];
  const after = results["after"]?.filter((result) => result.query === query) ?? [];
  const text = before[0]?.text;
  if (
    !before.length ||
    !after.length ||
    [...before, ...after].some((result) => result.text !== text)
  )
    throw new Error(`Search output changed for ${query}`);
  return { query, before: summarize(before), after: summarize(after), identicalOutput: true };
});
const beforePictures = screenshots["before"] ?? [],
  afterPictures = screenshots["after"] ?? [];
const hashes = [...beforePictures, ...afterPictures].map((result) => result.pictureHash);
type Look = Awaited<ReturnType<ReturnType<typeof world>["look"]>>;
const pairedSamples: Record<"before" | "after", Look[]> = { before: [], after: [] };
const paired = { before: world(config.before), after: world(config.after) };
try {
  await paired.before.look({ outline: false });
  await paired.after.look({ outline: false });
  for (let round = 0; round < 30; round++) {
    const order: ("before" | "after")[] = round % 2 ? ["after", "before"] : ["before", "after"];
    for (const label of order)
      pairedSamples[label].push(await paired[label].look({ outline: false }));
  }
} finally {
  paired.before.close();
  paired.after.close();
}
const pairedHashes = [...pairedSamples.before, ...pairedSamples.after].map(
  (result) => result.pictureHash,
);
console.log(
  JSON.stringify(
    {
      rounds: config.rounds,
      firstSearchAfterFullLookMs: firstSearchMs,
      freshSearchAfterEdit: true,
      controlsRetainedAfterSearch: true,
      appStayedBackground: true,
      search: report,
      screenshotOnly: {
        before: summarize(beforePictures),
        after: summarize(afterPictures),
        picturesAvailable: hashes.every((hash) => hash !== undefined),
        identicalPictures: hashes.every((hash) => hash !== undefined && hash === hashes[0]),
      },
      pairedScreenshotOnly: {
        rounds: 30,
        before: summarize(pairedSamples.before),
        after: summarize(pairedSamples.after),
        identicalPictures: pairedHashes.every(
          (hash) => hash !== undefined && hash === pairedHashes[0],
        ),
      },
    },
    null,
    2,
  ),
);
