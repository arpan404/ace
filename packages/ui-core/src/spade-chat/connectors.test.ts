import { expect, test } from "vitest";
import {
  parseSpadeConnectStart,
  parseSpadeConnectorAccess,
  parseSpadeConnectors,
  spadeConnectorLine,
} from "./connectors.ts";

test("connectors read leniently: unknown sign-ins drop, an unknown state never reads as connected", () => {
  const read = parseSpadeConnectors(
    JSON.stringify({
      catalogue: [
        {
          id: "linear",
          name: "Linear",
          url: "https://mcp.linear.app/mcp",
          sign_in: ["oauth", "magic", "token"],
        },
        { name: "no id" },
      ],
      connectors: [
        {
          id: "linear",
          name: "Linear",
          url: "https://mcp.linear.app/mcp",
          sign_in: "oauth",
          state: "teleporting",
          tools: 4,
        },
        { id: "notion", state: "connected", account: "me@example.com" },
      ],
    }),
  );
  expect(read?.catalogue.map((entry) => [entry.id, entry.signIn])).toEqual([
    ["linear", ["oauth", "token"]],
  ]);
  expect(read?.connectors.map((c) => [c.id, c.state])).toEqual([
    ["linear", "connecting"],
    ["notion", "connected"],
  ]);
  const notion = read?.connectors[1];
  expect(notion && spadeConnectorLine(notion)).toBe("Connected as me@example.com");
});

test("connecting answers either a connector or a sign-in address, and nothing else", () => {
  expect(
    parseSpadeConnectStart(JSON.stringify({ id: "linear", sign_in_url: "https://auth.example/a" })),
  ).toEqual({
    kind: "sign_in",
    id: "linear",
    url: "https://auth.example/a",
  });
  expect(
    parseSpadeConnectStart(JSON.stringify({ id: "x", sign_in_url: "javascript:alert(1)" })),
  ).toBeUndefined();
  expect(
    parseSpadeConnectStart(JSON.stringify({ connector: { id: "linear", state: "connected" } }))
      ?.kind,
  ).toBe("connected");
});

test("a bot's allow list reads only with its all flag", () => {
  expect(
    parseSpadeConnectorAccess(JSON.stringify({ all: false, connectors: ["linear", 3] })),
  ).toEqual({
    all: false,
    connectors: ["linear"],
  });
  expect(parseSpadeConnectorAccess(JSON.stringify({ connectors: [] }))).toBeUndefined();
});
