import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pairingLinkProof } from "@ace/client/link-proof";
import { CommandId, DeviceId, type CommandResult } from "@ace/protocol";
import { afterEach, expect, it } from "vitest";
import { Store } from "./store.ts";

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const close of cleanup.splice(0).toReversed()) close();
});

/** A store with a pairing and the same install's ace account device, linked (ADR 0115). */
async function linked() {
  const home = mkdtempSync(join(tmpdir(), "ace-receipt-owner-"));
  cleanup.push(() => rmSync(home, { recursive: true, force: true }));
  const store = new Store(join(home, "events.sqlite"), console.error);
  cleanup.push(() => store.close());
  const paired = store.devices.create("Phone", ["read", "operate"], 1000);
  const account = DeviceId.parse("account-phone");
  const proof = await pairingLinkProof(paired.token, paired.device.id, account, crypto.subtle);
  expect(store.devices.link(account, proof, 1000)).toBe(true);
  return { store, paired: paired.device.id, account };
}
const refused = (id: CommandId): CommandResult => ({ commandId: id, ok: false, error: "busy" });
const accepted = (id: CommandId): CommandResult => ({ commandId: id, ok: true });

it("the linked account device releases the pairing's refused command, so the same id runs again", async () => {
  const { store, paired, account } = await linked();
  const id = CommandId.parse("refused-over-lan");
  store.recordCommand(id, paired, () => refused(id));

  store.releaseRefusedCommand(id, account);

  expect(store.commandReceipt(id, paired)).toBeUndefined();
  expect(store.recordCommand(id, account, () => accepted(id))).toEqual(accepted(id));
});

it("the linked account device releases the pairing's pending review reservation", async () => {
  const { store, paired, account } = await linked();
  const id = CommandId.parse("review-over-lan");
  store.recordCommand(id, paired, () => ({ commandId: id, ok: false, error: "review_pending" }));

  store.releaseReviewCommand(id, account);

  expect(store.commandReceipt(id, paired)).toBeUndefined();
});

it("another device releases nothing of the pairing's receipts", async () => {
  const { store, paired } = await linked();
  const stranger = DeviceId.parse("stranger");
  const refusedId = CommandId.parse("refused-over-lan");
  const reviewId = CommandId.parse("review-over-lan");
  store.recordCommand(refusedId, paired, () => refused(refusedId));
  store.recordCommand(reviewId, paired, () => ({
    commandId: reviewId,
    ok: false,
    error: "review_pending",
  }));

  store.releaseRefusedCommand(refusedId, stranger);
  store.releaseReviewCommand(reviewId, stranger);

  expect(store.commandReceipt(refusedId, paired)).toEqual(refused(refusedId));
  expect(store.commandReceipt(reviewId, paired)).toMatchObject({ error: "review_pending" });
});
