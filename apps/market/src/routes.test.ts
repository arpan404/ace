import { describe, expect, it } from "vitest";
import { matchRoute } from "./routes.ts";

const hash = "a".repeat(64);

describe("routing", () => {
  it.each([
    ["GET", "/v1/index", { kind: "index" }],
    ["HEAD", "/v1/index", { kind: "index" }],
    ["GET", "/v1/entries/suit/tarn", { kind: "entry", type: "suit", name: "tarn" }],
    [
      "GET",
      "/v1/entries/spade-bot/inbox/1.2.0-beta.1",
      { kind: "version", type: "spade-bot", name: "inbox", version: "1.2.0-beta.1" },
    ],
    ["GET", `/v1/objects/${hash}`, { kind: "object", hash }],
    [
      "POST",
      "/v1/publish/spade-skill/notes/versions",
      { kind: "publish", type: "spade-skill", name: "notes" },
    ],
    [
      "POST",
      "/v1/publish/spade-skill/notes/versions/1.0.0/withdraw",
      { kind: "withdraw", type: "spade-skill", name: "notes", version: "1.0.0" },
    ],
    ["GET", "/v1/signer/pending", { kind: "signer-pending" }],
    ["GET", `/v1/signer/objects/${hash}`, { kind: "signer-object", hash }],
    [
      "PUT",
      "/v1/signer/reviews/suit/tarn/1.0.0",
      { kind: "signer-review", type: "suit", name: "tarn", version: "1.0.0" },
    ],
    ["PUT", "/v1/signer/featured", { kind: "signer-featured" }],
    ["GET", "/v1/discover", { kind: "discover" }],
    ["GET", "/v1/blocklist", { kind: "blocklist" }],
    ["GET", "/v1/verified", { kind: "verified" }],
    ["GET", "/v1/publishers/harbour-works", { kind: "publisher", handle: "harbour-works" }],
    ["GET", `/v1/avatars/${hash}`, { kind: "avatar", hash }],
    ["POST", "/v1/reports", { kind: "report" }],
    ["GET", "/v1/me", { kind: "me" }],
    ["POST", "/v1/me/profile", { kind: "me-profile-create" }],
    ["PUT", "/v1/me/profile", { kind: "me-profile-edit" }],
    ["PUT", "/v1/me/handle", { kind: "me-handle" }],
    ["POST", "/v1/me/verification/check", { kind: "me-verification-check" }],
    ["POST", "/v1/me/drafts", { kind: "me-draft-create" }],
    ["PATCH", "/v1/me/drafts/drf_abcdefgh12", { kind: "me-draft-patch", id: "drf_abcdefgh12" }],
    ["DELETE", "/v1/me/drafts/drf_abcdefgh12", { kind: "me-draft-delete", id: "drf_abcdefgh12" }],
    [
      "POST",
      "/v1/me/drafts/drf_abcdefgh12/publish",
      { kind: "me-draft-publish", id: "drf_abcdefgh12" },
    ],
    ["DELETE", "/v1/me/entries/suit/tarn", { kind: "me-entry-delete", type: "suit", name: "tarn" }],
    [
      "PUT",
      "/v1/me/entries/suit/tarn/previews/2",
      { kind: "me-preview", type: "suit", name: "tarn", index: 2 },
    ],
    [
      "DELETE",
      "/v1/me/entries/suit/tarn/versions/1.0.0/deprecation",
      { kind: "me-undeprecate", type: "suit", name: "tarn", version: "1.0.0" },
    ],
    [
      "POST",
      "/v1/me/transfers/trf_abcdefgh12/accept",
      { kind: "me-transfer-accept", id: "trf_abcdefgh12" },
    ],
    [
      "PUT",
      "/v1/signer/holds/suit/tarn/1.0.0",
      { kind: "signer-hold", type: "suit", name: "tarn", version: "1.0.0" },
    ],
    [
      "PUT",
      "/v1/signer/listings/suit/tarn",
      { kind: "signer-listing", type: "suit", name: "tarn" },
    ],
    ["GET", "/v1/signer/publishers/tester", { kind: "signer-publisher-read", handle: "tester" }],
    ["PUT", "/v1/signer/verified", { kind: "signer-verified" }],
  ])("%s %s names its route", (method, path, route) => {
    expect(matchRoute(method, path)).toEqual({ route });
  });

  it.each([
    ["an unknown type", "/v1/entries/theme/tarn"],
    ["a name with capitals", "/v1/entries/suit/Tarn"],
    ["a version that isn't dotted numbers", "/v1/entries/suit/tarn/latest"],
    ["a short hash", "/v1/objects/abc"],
    ["an encoded path", "/v1/entries/suit/..%2Fsecret"],
    ["a trailing segment", "/v1/index/more"],
    ["a page path", "/suit/tarn"],
    ["a draft id of the wrong shape", "/v1/me/drafts/../../x"],
    ["a fifth listing picture", "/v1/me/entries/suit/tarn/previews/4"],
    ["an unknown action on a version", "/v1/me/entries/suit/tarn/versions/1.0.0/delete"],
  ])("names nothing for %s", (_label, path) => {
    expect(matchRoute("GET", path)).toEqual({ refused: 404 });
  });

  it("refuses a known path with another method", () => {
    expect(matchRoute("POST", "/v1/index")).toEqual({ refused: 405 });
    expect(matchRoute("GET", "/v1/signer/featured")).toEqual({ refused: 405 });
    expect(matchRoute("POST", "/v1/me/drafts/drf_abcdefgh12")).toEqual({ refused: 405 });
  });
});
