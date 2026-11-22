import { describe, expect, it } from "vitest";
import { toCliError } from "../errors.ts";
import { marketUrl } from "./maintainer-io.ts";

const args = (flags: Record<string, string>) => ({ words: [], flags });
const failure = (flags: Record<string, string>) => {
  try {
    marketUrl(args(flags));
  } catch (error) {
    return toCliError(error);
  }
  throw new Error("expected a refusal");
};

describe("where the maintainer tools send the signer token", () => {
  it("is store.acehq.dev unless told otherwise, and also accepts legacy market.acehq.dev", () => {
    expect(marketUrl(args({})).origin).toBe("https://store.acehq.dev");
    expect(marketUrl(args({ url: "https://store.acehq.dev" })).origin).toBe(
      "https://store.acehq.dev",
    );
    expect(marketUrl(args({ url: "https://market.acehq.dev" })).origin).toBe(
      "https://market.acehq.dev",
    );
  });

  it("goes to a development market only when it is named with --dev-market", () => {
    expect(marketUrl(args({ "dev-market": "http://127.0.0.1:8787" })).origin).toBe(
      "http://127.0.0.1:8787",
    );
    expect(marketUrl(args({ "dev-market": "https://market.staging.example" })).origin).toBe(
      "https://market.staging.example",
    );
  });

  it.each([
    ["https://attacker.example"],
    ["http://localhost:8787"],
    ["https://store.acehq.dev.attacker.example"],
    ["https://market.acehq.dev.attacker.example"],
  ])("never goes to --url %s", (url) => {
    expect(failure({ url })).toMatchObject({ status: "usage", argument: "--url" });
  });

  it("a development market is still https or this machine", () => {
    expect(failure({ "dev-market": "http://market.staging.example" })).toMatchObject({
      status: "usage",
      argument: "--dev-market",
    });
  });
});
