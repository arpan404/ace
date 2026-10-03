import { z } from "zod";
import { afterEach, expect, it } from "vitest";
import { harness, scope, toolHeaders, toolRequest } from "./test-support.ts";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).toReversed()) await close();
});
it("rejects missing and mismatched mirrored custom headers before effects and decodes encoded values", async () => {
  const h = await harness(cleanups);
  const effects: string[] = [];
  const schema = z.strictObject({ scope: z.string().meta({ "x-mcp-header": "Scope" }) });
  h.registry.register({
    name: "ace_scoped",
    description: "Scoped effect",
    input: schema,
    output: schema,
    capability: null,
    timeoutMs: 1000,
    async run(value) {
      effects.push(value.scope);
      return value;
    },
  });
  const lease = h.credentials.issue(scope(), new AbortController().signal);
  const send = (value: string, header?: string) =>
    fetch(h.server.url, {
      method: "POST",
      headers: {
        ...toolHeaders(lease.bearer, "ace_scoped"),
        ...(header === undefined ? {} : { "Mcp-Param-Scope": header }),
      },
      body: JSON.stringify(toolRequest("ace_scoped", { scope: value })),
    });
  for (const header of [undefined, "wrong"]) {
    const response = await send("expected", header);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: -32020 } });
    expect(effects).toEqual([]);
  }
  for (const value of [
    "expected",
    "Hello, 世界",
    " padded ",
    "line1\nline2",
    "=?base64?literal?=",
  ]) {
    const encoded =
      value === "expected" ? value : `=?base64?${Buffer.from(value).toString("base64")}?=`;
    const response = await send(value, encoded);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      result: { structuredContent: { scope: value } },
    });
  }
  expect(effects).toEqual([
    "expected",
    "Hello, 世界",
    " padded ",
    "line1\nline2",
    "=?base64?literal?=",
  ]);
});

it("rejects a raw hostile Host with a valid tool request before effects", async () => {
  const { request } = await import("node:http");
  const h = await harness(cleanups);
  const effects: string[] = [];
  const schema = z.strictObject({ value: z.string() });
  h.registry.register({
    name: "ace_echo",
    description: "Echo",
    input: schema,
    output: schema,
    capability: null,
    timeoutMs: 1000,
    async run(value) {
      effects.push(value.value);
      return value;
    },
  });
  const lease = h.credentials.issue(scope(), new AbortController().signal);
  const status = await new Promise<number | undefined>((resolve, reject) => {
    const outgoing = request(
      h.server.url,
      {
        method: "POST",
        headers: { ...toolHeaders(lease.bearer, "ace_echo"), Host: "evil.example" },
      },
      (response) => {
        response.resume();
        response.once("end", () => resolve(response.statusCode));
        response.once("error", reject);
      },
    );
    outgoing.once("error", reject);
    outgoing.end(JSON.stringify(toolRequest("ace_echo", { value: "hostile" })));
  });
  expect(status).toBe(403);
  expect(effects).toEqual([]);
  const { client } = await h.connect();
  expect(
    await client.callTool({ name: "ace_echo", arguments: { value: "allowed" } }),
  ).toMatchObject({
    structuredContent: { value: "allowed" },
  });
  expect(effects).toEqual(["allowed"]);
});
