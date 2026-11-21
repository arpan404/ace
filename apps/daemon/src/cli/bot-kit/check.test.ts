import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CliFailure } from "../output.ts";
import { writeArchive } from "@ace/marketplace";
import { folder as archiveFiles, signedVersion } from "@ace/marketplace/testing";
import { checkAgainstPublished, checkPackage, marketReads } from "./check.ts";

/** Flight watcher with its one contract, `cheapest_fare`, as `input` and `required` shape it. */
const watcher = (required: string[]) => ({
  format: "spade-bot",
  version: 3,
  requires: { runtime: "1" },
  name: "Flight watcher",
  blurb: "Watches fares for the trips you name.",
  task: "You watch flight fares for the person.",
  contracts: [
    {
      name: "cheapest_fare",
      summary: "The cheapest fare seen for a route this week.",
      input: {
        type: "object",
        properties: {
          from: { type: "string", maxLength: 3 },
          to: { type: "string", maxLength: 3 },
          month: { type: "string", maxLength: 7 },
        },
        required,
      },
      output: {
        type: "object",
        properties: { fare: { type: "number" } },
        required: ["fare"],
      },
    },
  ],
  tests: ["tests/answers.json"],
  pricing: { kind: "free" },
});

const folders: string[] = [];
afterEach(async () => {
  await Promise.all(folders.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function folder(bot: unknown): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "bot-check-"));
  folders.push(dir);
  const root = join(dir, "flight-watcher");
  await mkdir(join(root, "tests"), { recursive: true });
  await writeFile(join(root, "bot.json"), JSON.stringify(bot, null, 2));
  await writeFile(join(root, "README.md"), "# Flight watcher\n\nWatches fares.\n");
  await writeFile(
    join(root, "tests/answers.json"),
    JSON.stringify({
      name: "Answers",
      given: { call: { contract: "cheapest_fare", input: { from: "KTM", to: "DEL" } } },
      model: [{ say: "Sent." }],
    }),
  );
  return root;
}

describe("ace bot check against the version other bots call", () => {
  it("passes a version that keeps its contracts' callers working", async () => {
    const before = await folder(watcher(["from", "to", "month"]));
    const after = await folder(watcher(["from", "to"]));
    const checked = await checkPackage(after, { against: before });
    expect(checked.name).toBe("flight-watcher");
  });

  it("refuses a change that would break its callers, with each change at its place", async () => {
    const before = await folder(watcher(["from", "to"]));
    const after = await folder(watcher(["from", "to", "month"]));
    const failure = await checkPackage(after, { against: `${before}/bot.json` }).catch(
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(CliFailure);
    expect(String((failure as CliFailure).message)).toContain("would break bots that call it");
    expect(JSON.stringify(failure)).toContain(
      "contracts: cheapest_fare: input.month became required. A change that breaks callers takes a new contract name.",
    );
    // Checked alone, the same folder passes: only callers make it a break.
    await expect(checkPackage(after)).resolves.toMatchObject({ name: "flight-watcher" });
  });

  it("compares a contract whose schemas live in contracts/<name>.json as written there", async () => {
    /** `watcher(required)` with its contract's schemas moved to a file of the package. */
    async function moved(required: string[]) {
      const bot = watcher(required);
      const [first] = bot.contracts;
      if (!first) throw new Error("the watcher has a contract");
      const { input, output, ...rest } = first;
      const root = await folder({
        ...bot,
        contracts: [{ ...rest, file: "contracts/cheapest-fare.json" }],
      });
      await mkdir(join(root, "contracts"));
      await writeFile(
        join(root, "contracts/cheapest-fare.json"),
        JSON.stringify({ input, output }),
      );
      return root;
    }
    const inline = await folder(watcher(["from", "to"]));
    // The same schemas, only moved: nothing breaks.
    await expect(
      checkPackage(await moved(["from", "to"]), { against: inline }),
    ).resolves.toMatchObject({ name: "flight-watcher" });
    const failure = await checkPackage(await moved(["from", "to", "month"]), {
      against: inline,
    }).catch((error: unknown) => error);
    expect(JSON.stringify(failure)).toContain("cheapest_fare: input.month became required");
  });
});

describe("ace bot publish against the version published in the market", () => {
  const signed = signedVersion({
    type: "spade-bot",
    name: "flight-watcher",
    files: archiveFiles({ "bot.json": JSON.stringify(watcher(["from", "to"])) }),
  });

  /** A market serving flight-watcher 1.0.0 on its public read routes, on this machine. */
  async function market(): Promise<{ origin: string; close(): void }> {
    const server = createServer((request, response) => {
      const routes: Record<string, () => void> = {
        "/v1/entries/spade-bot/flight-watcher": () =>
          response.end(
            JSON.stringify({
              entry: {},
              versions: [
                { version: "1.0.0", hash: signed.hash, size: 1, published: 1, downloads: 0 },
              ],
            }),
          ),
        "/v1/entries/spade-bot/flight-watcher/1.0.0": () =>
          response.end(JSON.stringify({ manifest: signed.manifest })),
        [`/v1/objects/${signed.hash}`]: () =>
          response.end(
            writeArchive(archiveFiles({ "bot.json": JSON.stringify(watcher(["from", "to"])) })),
          ),
      };
      const route = routes[request.url ?? ""];
      if (route) route();
      else {
        response.statusCode = 404;
        response.end("{}");
      }
    });
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    return { origin: `http://127.0.0.1:${port}`, close: () => server.close() };
  }

  it("refuses a version whose contracts break bots calling the published one", async () => {
    const served = await market();
    try {
      const failure = await checkAgainstPublished(
        "flight-watcher",
        watcher(["from", "to", "month"]),
        marketReads(served.origin),
      ).catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(CliFailure);
      expect((failure as CliFailure).message).toBe(
        "Its contracts would break bots that call 1.0.0: cheapest_fare: input.month became required. A breaking change takes a new contract name.",
      );
      // A change callers survive, and a package never published, go on to upload.
      await checkAgainstPublished("flight-watcher", watcher(["from"]), marketReads(served.origin));
      await checkAgainstPublished(
        "hotel-scout",
        watcher(["from", "to", "month"]),
        marketReads(served.origin),
      );
    } finally {
      served.close();
    }
  });
});

async function skill(name: string, front: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "skill-check-"));
  folders.push(dir);
  const root = join(dir, name);
  await mkdir(root, { recursive: true });
  await writeFile(join(root, "SKILL.md"), `---\n${front}\n---\n# Triage mail\n`);
  return root;
}

describe("ace bot check on a SKILL.md folder", () => {
  it("passes a skill meeting the specification, naming what it keeps unused and what allowed-tools means", async () => {
    const root = await skill(
      "triage-mail",
      "name: triage-mail\ndescription: Sorts mail.\nallowed-tools: Bash Read\nmodel: fast",
    );
    const checked = await checkPackage(root);
    expect(checked.name).toBe("triage-mail");
    expect(checked.warnings.map((warning) => warning.message)).toEqual([
      "Not used by this Spade: model.",
      "It asks to run Bash and Read without asking. Spade still decides each call.",
    ]);
  });

  it("refuses a skill breaking the specification, with the rule at its line", async () => {
    const root = await skill(
      "triage-mail",
      "name: triage-mail\ndescription: Sorts.\nname2: x\nlicense: [1]",
    );
    const failure = await checkPackage(root).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(CliFailure);
    expect(JSON.stringify(failure)).toContain("license must be text");
  });

  it("refuses a skill whose name isn't its folder's", async () => {
    const root = await skill("mail", "name: triage-mail\ndescription: Sorts mail.");
    const failure = await checkPackage(root).catch((error: unknown) => error);
    expect(JSON.stringify(failure)).toContain("name must be the folder's name, mail");
  });
});
