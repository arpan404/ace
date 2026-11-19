import type { ServerMessage } from "@ace/protocol";
import type { ArchiveFile } from "@ace/marketplace";
import {
  folder,
  sampleSkill,
  samplePlugin,
  sampleRecipe,
  sampleSuit,
  signedVersion,
} from "@ace/marketplace/testing";
import type { MarketEntryType } from "@ace/protocol/marketplace";
import { afterEach, expect, test } from "vitest";
import { fakeMarket, fakeSpade, marketplaceHarness } from "./marketplace/test-support.ts";
import { fixture, type Client } from "./socket-test-support.ts";

/*
 * Installing content only over the host token (ADR 0178 §12.8): a real daemon socket holding
 * only the token file, with no ace account at all, so no sign-in can be fresh. A Suit and a Spade
 * skill install; a plugin, and a skill carrying an executable file, still need the sign-in. A
 * real socket: the exemption is decided on the daemon's own review of bytes it fetched, which
 * only a prepared review behind the socket has.
 */

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const step of cleanup.splice(0).toReversed()) await step();
});

async function world() {
  const market = await fakeMarket();
  cleanup.push(() => market.close());
  const spade = await fakeSpade();
  cleanup.push(() => spade.close());
  const harness = await marketplaceHarness({ origin: market.origin, spade });
  cleanup.push(() => harness.close());
  const f = await fixture({ marketplace: harness.service });
  cleanup.push(() => f.close());
  const socket = await f.connect();
  await until(socket, (message) => message.type === "welcome");
  let requests = 0;
  const ask = async (operation: unknown) => {
    const requestId = `r${++requests}`;
    socket.socket.send(JSON.stringify({ type: "marketplace.request", requestId, operation }));
    const answer = await until(
      socket,
      (message) => message.type === "marketplace.result" && message.requestId === requestId,
    );
    return answer.type === "marketplace.result" ? answer.result : undefined;
  };
  /** Publish `files` as `type/name`, review it over the socket, and install that review. */
  const install = async (type: MarketEntryType, name: string, files: ArchiveFile[]) => {
    market.publish(signedVersion({ type, name, files }), files);
    const prepared = await ask({ op: "prepare", source: "market", type, name });
    if (prepared?.op !== "review") throw new Error(`No review: ${JSON.stringify(prepared)}`);
    return ask({ op: "install", id: prepared.review.id, hash: prepared.review.hash });
  };
  /** Publish without installing: what a recipe brings. */
  const publish = (type: MarketEntryType, name: string, files: ArchiveFile[]) =>
    market.publish(signedVersion({ type, name, files }), files);
  return { install, publish };
}

async function until(client: Client, match: (message: ServerMessage) => boolean) {
  for (;;) {
    const message = await client.next();
    if (match(message)) return message;
  }
}

test("a host-token socket installs a Suit and a Spade skill with no fresh sign-in", async () => {
  const { install } = await world();
  expect(await install("suit", "harbour-dusk", sampleSuit())).toMatchObject({ op: "done" });
  expect(await install("spade-skill", "triage-mail", sampleSkill())).toMatchObject({
    op: "done",
  });
});

test("installing a bot, a plugin, or a skill carrying an executable file, still needs the sign-in", async () => {
  const { install, publish } = await world();
  const reauth = { op: "error", code: "reauth" };
  expect(await install("spade-plugin", "mail-tools", samplePlugin())).toMatchObject(reauth);
  const runnable = [
    ...sampleSkill("sort-mail"),
    ...folder({ "scripts/sort.sh*": "#!/bin/sh\nexit 0\n" }),
  ];
  expect(await install("spade-skill", "sort-mail", runnable)).toMatchObject(reauth);
  // A bot that brings only content still makes a bot, which runs on its own.
  publish("spade-skill", "triage-mail", sampleSkill());
  expect(await install("spade-bot", "inbox", sampleRecipe({ plugins: [] }))).toMatchObject(reauth);
});
