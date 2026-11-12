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
    parseSpadeConnectStart(JSON.stringify({ id: "x", sign_in_url: "http://auth.example/a" })),
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

test("a device sign-in reads its code and https page; any other page is refused", () => {
  expect(
    parseSpadeConnectStart(
      JSON.stringify({
        id: "github",
        device: { code: "WDJB-MJHT", url: "https://github.com/login/device", expires_in: 900 },
      }),
    ),
  ).toEqual({
    kind: "device",
    id: "github",
    code: "WDJB-MJHT",
    url: "https://github.com/login/device",
  });
  for (const url of ["http://github.com/login/device", "javascript:alert(1)"])
    expect(
      parseSpadeConnectStart(JSON.stringify({ id: "github", device: { code: "C", url } })),
    ).toBeUndefined();
  const read = parseSpadeConnectors(
    JSON.stringify({
      connectors: [
        {
          id: "github",
          name: "GitHub",
          state: "needs_reconnect",
          device: { code: "WDJB-MJHT", url: "https://github.com/login/device", state: "expired" },
        },
        {
          id: "box",
          name: "Box",
          state: "signing_in",
          device: { code: "X", url: "https://box.example/device", state: "teleporting" },
        },
      ],
    }),
  );
  const [github, box] = read?.connectors ?? [];
  expect(github && spadeConnectorLine(github)).toBe("The code expired before it was entered.");
  expect(box?.device?.state).toBe("waiting");
  expect(box && spadeConnectorLine(box)).toBe("Enter X on Box's page to finish signing in.");
});
