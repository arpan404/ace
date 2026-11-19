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

/** A daemon holding one file, which (as the real one does) withholds bytes past `maxSize`. */
function holding(bytes: Uint8Array): ClientApi {
  const part = 256 * 1024;
  return {
    request: async (input: { operation: { path: string; offset: number; maxSize: number } }) => {
      const { path, offset, maxSize } = input.operation;
      const base = { path, version: "v1", type: "file", size: bytes.length, offset };
      if (bytes.length > maxSize) return { type: "files.result", value: base };
      const data = Buffer.from(bytes.subarray(offset, offset + part)).toString("base64");
      return { type: "files.result", value: { ...base, encoding: "identity", data } };
    },
  } as unknown as ClientApi;
}

test("a checkout image over the text limit still opens as a picture", async () => {
  const png = new Uint8Array(3 * 1024 * 1024);
  png.set([137, 80, 78, 71, 13, 10, 26, 10]);
  const read = await daemonCheckout(holding(png)).read("thread", "docs/screenshot.png");
  expect(read.kind).toBe("image");
});

test("a checkout source file over the text limit still says it is too large", async () => {
  const text = new TextEncoder().encode("x".repeat(3 * 1024 * 1024));
  const read = await daemonCheckout(holding(text)).read("thread", "src/huge.ts");
  expect(read.kind).toBe("large");
});
