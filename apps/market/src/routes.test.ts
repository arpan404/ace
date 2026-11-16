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
    ["GET", "/", { kind: "page-home" }],
    ["GET", "/search", { kind: "page-search" }],
    ["GET", "/suit/tarn", { kind: "page-entry", type: "suit", name: "tarn" }],
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
    ["an unknown page", "/suit/tarn/extra"],
  ])("names nothing for %s", (_label, path) => {
    expect(matchRoute("GET", path)).toEqual({ refused: 404 });
  });

  it("refuses a known path with another method", () => {
    expect(matchRoute("POST", "/v1/index")).toEqual({ refused: 405 });
    expect(matchRoute("GET", "/v1/signer/featured")).toEqual({ refused: 405 });
  });
});
