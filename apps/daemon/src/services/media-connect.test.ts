import { MediaConnections, MediaIssue } from "@ace/media/media-connections";
import { expect, test } from "vitest";
import { mediaAdmission } from "./media-connect.ts";

// Paired credentials' generations are hashes (`devices.ts`), not numbers.
const before = "3f9a1c0e7b2d4a6c8e1f0b2d4c6e8a1f";
const after = "c41e9b0a2f7d3e5c6a8b1d0f2e4c6a8b";

// A main session reads its admission from the socket (`credentialGeneration`, `accountDevice`),
// a relay channel from its hello (`device.generation`, `account`). The same credential must be
// the same admission on both, and every other credential another one.
test("each credential is its own admission, the same on a main session and on its channels", () => {
  expect(mediaAdmission(undefined, before)).toEqual(mediaAdmission(undefined, before));
  expect(mediaAdmission(undefined, before)).not.toEqual(mediaAdmission(undefined, after));
  expect(mediaAdmission("acct", before)).toEqual({ kind: "account", account: "acct" });
  expect(mediaAdmission("acct", undefined)).not.toEqual(mediaAdmission(undefined, undefined));
});

test("a channel left from a replaced credential can't bind views on the new one's connection", async () => {
  const connections = new MediaConnections({
    port: {
      send: () => true,
      revoke: () => Promise.resolve("answered"),
      directPort: () => 41_000,
      need: () => () => {},
      sleep: () => Promise.resolve(),
    },
    issue: new MediaIssue(),
    now: () => 0,
    randomBytes: (length) => new Uint8Array(length).fill(7),
    id: () => "id",
  });
  // The device paired again: its main session holds the new credential.
  const owner = { session: "main", device: "phone", admission: mediaAdmission(undefined, after) };
  const grant = await connections.connect(owner);
  if (!grant.ok) throw new Error(grant.code);
  const stale = {
    session: "old-channel",
    device: "phone",
    admission: mediaAdmission(undefined, before),
  };
  expect(connections.owned(stale, grant.connection)).toBeUndefined();
  const current = {
    session: "new-channel",
    device: "phone",
    admission: mediaAdmission(undefined, after),
  };
  expect(connections.owned(current, grant.connection)).toEqual(owner);
});
