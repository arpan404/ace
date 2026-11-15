import { expect, test } from "vitest";
import { mediaAdmission } from "./media-connect.ts";

// A main session reads its admission from the socket (`credentialGeneration`, `accountDevice`),
// a relay channel from its hello (`device.generation`, `account`). Both must yield the same
// admission for the same credential, or a channel of the same device is refused its own
// device's media connection (iOS subscribes to screens and devices on channels of their own).
test("the same credential is the same admission on a main session and on its channels", () => {
  expect(mediaAdmission(undefined, "3")).toEqual(mediaAdmission(undefined, "3"));
  expect(mediaAdmission(undefined, "3")).toEqual({ kind: "pairing", generation: 3 });
  expect(mediaAdmission("acct", "3")).toEqual({ kind: "account", account: "acct" });
  // Another generation is another credential, and an account admission is never a pairing's.
  expect(mediaAdmission(undefined, "4")).not.toEqual(mediaAdmission(undefined, "3"));
  expect(mediaAdmission("acct", undefined)).not.toEqual(mediaAdmission(undefined, undefined));
});
