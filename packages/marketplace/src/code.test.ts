import { describe, expect, it } from "vitest";
import { writeArchive } from "./archive.ts";
import { checkFiles } from "./checks/index.ts";
import { codeReviewRow } from "./code.ts";
import { contentHash, hashFiles } from "./hash.ts";
import { disposition, scanEntry } from "./scan/index.ts";
import { signPending, type CodeChecker, type SignerIo } from "./signer.ts";
import { folder, keySetOf, samplePackage, testKey, testPublisher } from "./testing.ts";

/*
 * A bot package's WebAssembly components (ADR 0203 §5) through the market: the Worker's checks
 * read the header, the size and the manifest's list; the scan accepts components under `code/`
 * and holds every version with code for a maintainer; the signer has Spade's program read the
 * binary before it signs.
 */

const component = () => Uint8Array.of(0x00, 0x61, 0x73, 0x6d, 0x0d, 0x00, 0x01, 0x00);
const coreModule = () => Uint8Array.of(0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00);
const cwasm = () => Uint8Array.of(0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01, 0x01, 0x00);

const entry = {
  name: "fares",
  file: "code/fares.wasm",
  world: "spade:package/bot-tools@1.0.0",
  imports: ["spade:package/tools", "wasi:clocks/wall-clock@0.2"],
  why: "Parses fare tables and picks the cheapest.",
};

const withCode = (files: Record<string, string | Uint8Array>, code: unknown[] = [entry]) => [
  ...samplePackage({ code }),
  ...folder(files),
];

const messages = (files: ReturnType<typeof withCode>) =>
  checkFiles("spade-bot", "flight-watcher", files).problems.map((problem) => problem.message);

describe("a package's components in the market's checks", () => {
  it("pass a component its manifest names, with a review row from its imports", () => {
    const checked = checkFiles(
      "spade-bot",
      "flight-watcher",
      withCode({ "code/fares.wasm": component(), "code/src/lib.rs": "// source" }),
    );
    expect(checked.problems).toEqual([]);
    const recipe = checked.inspection?.type === "spade-bot" ? checked.inspection.recipe : undefined;
    expect(recipe?.code).toEqual([entry]);
    expect(recipe?.code?.map((code) => codeReviewRow(code, recipe.effects))).toEqual([
      "Runs its own code: fares. It can call Spade's tools as this bot.",
    ]);
  });

  it("refuse a core module in a component's place", () => {
    expect(messages(withCode({ "code/fares.wasm": coreModule() }))).toContain(
      "code/fares.wasm is a core WebAssembly module; Spade runs only components built for its world",
    );
  });

  it("refuse precompiled code, named as a component or beside one", () => {
    expect(messages(withCode({ "code/fares.wasm": cwasm() })).join("\n")).toContain(
      "precompiled code (.cwasm or any native file) is never accepted",
    );
    expect(
      messages(withCode({ "code/fares.wasm": component(), "code/fares.cwasm": cwasm() })),
    ).toContain(
      "code/fares.cwasm isn't a component bot.json names; code/ holds components, code/src/ and code/build.json",
    );
  });

  it("refuse a component the manifest names but the package doesn't hold", () => {
    expect(messages(withCode({}))).toContain(
      "code/fares.wasm is named in code but isn't in the package",
    );
  });

  it("refuse a manifest whose component imports the file system", () => {
    const problems = messages(
      withCode({ "code/fares.wasm": component() }, [
        { ...entry, imports: ["wasi:filesystem/types@0.2"] },
      ]),
    );
    expect(problems.join("\n")).toContain("code has no file system or sockets");
  });
});

const scanned = (files: ReturnType<typeof withCode>, type: "spade-bot" | "spade-skill") => {
  const checked = checkFiles(type, "flight-watcher", files);
  return scanEntry({
    type,
    name: "flight-watcher",
    files,
    listing: checked.listing,
    inspection: checked.inspection,
    context: { entries: [], verified: [] },
  });
};

describe("the scan of a package with code", () => {
  it("doesn't block a bot's component under code/, and holds the version for a maintainer", () => {
    const scan = scanned(withCode({ "code/fares.wasm": component() }), "spade-bot");
    expect(scan.findings.filter((finding) => finding.level === "block")).toEqual([]);
    expect(scan.runnable).toBe(true);
    // Whoever publishes it, ace included, and however established.
    for (const official of [true, false])
      expect(
        disposition(scan, { newPublisher: false, firstVersion: false, official, approved: false }),
      ).toBe("hold");
  });

  it("still blocks WebAssembly anywhere else", () => {
    const scan = scanned(
      [...samplePackage(), ...folder({ "assets/fares.wasm": component() })],
      "spade-bot",
    );
    expect(scan.findings.map((finding) => finding.rule)).toContain("wasm-outside-plugin");
  });
});

const passes: CodeChecker = async () => ({
  problems: [],
  components: [
    {
      name: "fares",
      file: "code/fares.wasm",
      sha256: "a".repeat(64),
      imports: entry.imports,
      exports: ["spade:package/toolbox"],
      review: "Runs its own code: fares. It can call Spade's tools as this bot.",
    },
  ],
});

describe("the signer and a package's code", () => {
  const key = testKey("market-2", 2);
  const trusted = keySetOf(key);
  const files = withCode({ "code/fares.wasm": component() });
  const pending = {
    "/v1/signer/pending": {
      versions: [
        {
          type: "spade-bot",
          name: "flight-watcher",
          version: "1.0.0",
          hash: contentHash(hashFiles(files)),
          publisher: testPublisher,
          size: 1,
          published: 1,
          approved: true,
        },
      ],
      withdrawals: [],
    },
    "/v1/signer/scan-context": { entries: [], verified: [], newPublishers: [] },
  };
  const market = () => {
    const puts: { path: string; body: unknown }[] = [];
    const io: SignerIo = {
      get: async (path) => pending[path as keyof typeof pending],
      object: async () => writeArchive(files),
      put: async (path, body) => {
        puts.push({ path, body });
        return { status: 200, text: "" };
      },
    };
    return { io, puts };
  };
  it("has Spade's program read the binary, and signs an approved version it passes", async () => {
    const { io } = market();
    const read: string[][] = [];
    const report = await signPending(io, key, () => 30, trusted, {
      checkCode: async (given) => {
        read.push(given.map((file) => file.path).toSorted());
        return passes(given);
      },
    });
    expect(read).toEqual([["README.md", "bot.json", "code/fares.wasm"]]);
    expect(report.signed).toEqual(["spade-bot/flight-watcher@1.0.0"]);
  });

  it("refuses for good a version whose binary differs from its manifest", async () => {
    const { io, puts } = market();
    const report = await signPending(io, key, () => 30, trusted, {
      checkCode: async () => ({
        problems: [
          "code/fares.wasm imports spade:package/http, but bot.json lists spade:package/tools; the two must be the same",
        ],
        components: [],
      }),
    });
    expect(report.signed).toEqual([]);
    expect(report.blocked).toEqual([
      {
        version: "spade-bot/flight-watcher@1.0.0",
        reason:
          "Its code was refused when ace's market read it: code/fares.wasm imports spade:package/http, but bot.json lists spade:package/tools; the two must be the same",
      },
    ]);
    expect(puts.map((put) => put.path)).toEqual([
      "/v1/signer/blocks/spade-bot/flight-watcher/1.0.0",
    ]);
  });

  it("leaves a version unsigned and pending when this signer can't read its code", async () => {
    for (const checkCode of [
      undefined,
      async () => {
        throw new Error("spade isn't installed");
      },
    ]) {
      const { io, puts } = market();
      const report = await signPending(io, key, () => 30, trusted, { checkCode });
      expect(report.signed).toEqual([]);
      expect(report.blocked).toEqual([]);
      expect(report.refused).toHaveLength(1);
      expect(puts).toEqual([]);
    }
  });
});
