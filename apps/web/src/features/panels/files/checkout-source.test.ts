import type { ClientApi } from "@ace/client";
import { expect, test } from "vitest";
import { daemonCheckout } from "./checkout-source.ts";

/** A client whose only answer is one completion reply. */
function completion(paths: string[], ready: boolean): ClientApi {
  return {
    request: async () => ({
      type: "context.result",
      requestId: "paths",
      result: { kind: "completion", paths, ready },
    }),
  } as unknown as ClientApi;
}

test("quick open keeps a building index's answer apart from an empty one", async () => {
  expect(await daemonCheckout(completion(["src/main.ts"], false)).search("thread", "main")).toEqual(
    { paths: ["src/main.ts"], ready: false },
  );
  expect(await daemonCheckout(completion([], true)).search("thread", "main")).toEqual({
    paths: [],
    ready: true,
  });
});
