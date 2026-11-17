import { describe, expect, it } from "vitest";
import type { MarketOperation } from "@ace/protocol/marketplace";
import { commandTable } from "../commands/table.ts";
import { CliFailure } from "../output.ts";
import { parseCommandLine } from "../parse.ts";
import { marketAction } from "./actions.ts";
import { parseRef } from "./refs.ts";

const table = commandTable();

/** The operation a command line sends, read through the real table and parser. */
function sent(line: string): MarketOperation {
  const parsed = parseCommandLine(table, line.split(" "));
  if (parsed.kind !== "command") throw new Error(`${line} didn't parse: ${JSON.stringify(parsed)}`);
  return marketAction(parsed.command.id, parsed);
}
const publish = (request: Record<string, unknown>) => ({ op: "publish", request });
const entry = { type: "suit", name: "dusk-harbor" };

describe("market references", () => {
  it.each([
    ["suit/dusk-harbor", { kind: "entry", ...entry, version: undefined }],
    [
      "spade-plugin/linear-sync@0.4.1",
      { kind: "entry", type: "spade-plugin", name: "linear-sync", version: "0.4.1" },
    ],
    ["@arpan", { kind: "publisher", handle: "arpan" }],
  ])("%s reads as what it names", (word, expected) => {
    expect(parseRef(word)).toEqual(expected);
  });

  it.each([
    ["dusk-harbor", "isn't a market entry"],
    ["theme/dusk-harbor", "theme isn't a market type"],
    ["suit/Dusk_Harbor", "isn't an entry name"],
    ["suit/dusk-harbor@latest", "latest isn't a version"],
    ["@Not_A_Handle", "isn't a publisher's handle"],
  ])("%s is a usage error that says what's wrong", (word, sentence) => {
    let failure: unknown;
    try {
      parseRef(word);
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(CliFailure);
    expect((failure as CliFailure).outcome).toBe("usage");
    expect((failure as CliFailure).message).toContain(sentence);
  });
});

describe("each market command sends one request", () => {
  it.each<[string, unknown]>([
    ["market", { op: "discover" }],
    [
      "market search linear sync --type spade-plugin --limit 5",
      { op: "search", query: "linear sync", type: "spade-plugin", offset: 0, limit: 5 },
    ],
    ["market show suit/dusk-harbor", { op: "read", source: "market", ...entry }],
    ["market show suit/dusk-harbor --source git:abc", { op: "read", source: "git:abc", ...entry }],
    ["market show @arpan", { op: "publisher", handle: "arpan" }],
    ["market remove suit/dusk-harbor", { op: "remove", ...entry }],
    ["market restore suit/dusk-harbor", { op: "turnOn", ...entry }],
    ["market installed", { op: "installed" }],
    ["market source", { op: "sources" }],
    ["market source off git:abc", { op: "setSource", id: "git:abc", enabled: false }],
    ["market source refresh", { op: "refresh" }],
    [
      "market report suit/dusk-harbor@1.2.0 --reason spam --note Ads",
      { op: "report", ...entry, version: "1.2.0", reason: "spam", note: "Ads" },
    ],
    ["market status", publish({ action: "me" })],
    ["market status suit/dusk-harbor", publish({ action: "entry", ...entry })],
    ["market versions suit/dusk-harbor", publish({ action: "entry", ...entry })],
    ["market draft show drf_abcdefgh", publish({ action: "draftRead", id: "drf_abcdefgh" })],
    ["market draft delete drf_abcdefgh", publish({ action: "draftDelete", id: "drf_abcdefgh" })],
    [
      "market draft update drf_abcdefgh --version 1.2.1",
      publish({ action: "draftUpdate", id: "drf_abcdefgh", version: "1.2.1" }),
    ],
    [
      "market changelog suit/dusk-harbor@1.2.0 Brighter",
      publish({ action: "changelog", ...entry, version: "1.2.0", text: "Brighter" }),
    ],
    [
      "market latest suit/dusk-harbor 1.1.0",
      publish({ action: "latest", ...entry, version: "1.1.0" }),
    ],
    [
      "market latest suit/dusk-harbor --newest",
      publish({ action: "latest", ...entry, version: null }),
    ],
    [
      "market deprecate suit/dusk-harbor@1.0.0 --note Old",
      publish({ action: "deprecate", ...entry, version: "1.0.0", note: "Old" }),
    ],
    [
      "market deprecate suit/dusk-harbor@1.0.0 --clear",
      publish({ action: "deprecate", ...entry, version: "1.0.0", note: null }),
    ],
    [
      "market visibility suit/dusk-harbor unlisted",
      publish({ action: "visibility", ...entry, visibility: "unlisted" }),
    ],
    ["market archive suit/dusk-harbor", publish({ action: "archive", ...entry, archived: true })],
    [
      "market unarchive suit/dusk-harbor",
      publish({ action: "archive", ...entry, archived: false }),
    ],
    [
      "market withdraw suit/dusk-harbor@1.1.0 --reason Contrast",
      publish({ action: "withdraw", ...entry, version: "1.1.0", reason: "Contrast" }),
    ],
    [
      "market withdraw suit/dusk-harbor --reason All",
      publish({ action: "withdraw", ...entry, reason: "All" }),
    ],
    [
      "market transfer suit/dusk-harbor --to @rijan",
      publish({ action: "transfer", ...entry, to: "rijan" }),
    ],
    [
      "market transfer accept trf_abcdefgh",
      publish({ action: "transferAnswer", id: "trf_abcdefgh", accept: true }),
    ],
    [
      "market transfer decline trf_abcdefgh",
      publish({ action: "transferAnswer", id: "trf_abcdefgh", accept: false }),
    ],
    ["market delete suit/dusk-harbor", publish({ action: "deleteEntry", ...entry })],
    ["market signals suit/dusk-harbor", publish({ action: "signals", ...entry })],
    [
      "market appeal suit/dusk-harbor@1.2.0 --note Fixed --replacement 1.2.1",
      publish({
        action: "appeal",
        ...entry,
        version: "1.2.0",
        note: "Fixed",
        replacement: "1.2.1",
      }),
    ],
    ["market profile handle @newname", publish({ action: "changeHandle", handle: "newname" })],
    [
      "market profile pins suit/dusk-harbor spade-skill/triage",
      publish({ action: "setPins", entries: [entry, { type: "spade-skill", name: "triage" }] }),
    ],
    ["market verification", publish({ action: "verification" })],
    [
      "market verification apply --domain example.com",
      publish({ action: "applyVerification", domain: "example.com" }),
    ],
    ["market verification check", publish({ action: "checkVerification" })],
  ])("ace %s", (line, operation) => {
    expect(sent(line)).toEqual(operation);
  });

  it.each([
    ["market withdraw suit/dusk-harbor", "--reason"],
    ["market deprecate suit/dusk-harbor --note Old", "REF"],
    ["market transfer suit/dusk-harbor", "--to"],
    ["market report suit/dusk-harbor", "--reason"],
    ["market visibility suit/dusk-harbor hidden", "VISIBILITY"],
    ["market source off github", "SOURCE"],
  ])("ace %s is a usage error naming %s", (line, argument) => {
    let failure: unknown;
    try {
      sent(line);
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(CliFailure);
    expect((failure as CliFailure).outcome).toBe("usage");
    expect((failure as CliFailure).detail.argument).toBe(argument);
  });
});
