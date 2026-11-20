import { expect, test } from "vitest";
import {
  parseSpadeConnectStart,
  parseSpadeConnectorAccess,
  parseSpadeConnectors,
  spadeCloudLine,
  spadeConnectorLine,
  spadeLastUsedWords,
  spadeSignInFailureWords,
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

test("an app through Spade Cloud says so quietly, or why it can't renew; others say nothing", () => {
  const read = parseSpadeConnectors(
    JSON.stringify({
      catalogue: [{ id: "asana", url: "https://mcp.asana.com/v2/mcp", via: "cloud" }],
      connectors: [
        { id: "asana", state: "connected", via: "cloud" },
        { id: "box", state: "connected", via: "cloud", notice: "cloud_unreachable" },
        { id: "canva", state: "connected", via: "cloud", notice: "ace_signed_out" },
        { id: "hubspot", state: "connected", via: "cloud", notice: "solar_flare" },
        { id: "linear", state: "connected", via: "carrier-pigeon" },
      ],
    }),
  );
  expect(read?.catalogue[0]?.via).toBe("cloud");
  expect(read?.connectors.map(spadeCloudLine)).toEqual([
    "Signs in through Spade Cloud",
    "Spade Cloud can't be reached. It keeps working until its sign-in runs out.",
    "Sign in to ace to keep it signed in through Spade Cloud.",
    "Signs in through Spade Cloud",
    undefined,
  ]);
});

test("a catalogue app says whether it can connect now, and an unknown answer never reads as Sign in", () => {
  const read = parseSpadeConnectors(
    JSON.stringify({
      catalogue: [
        {
          id: "slack",
          url: "https://mcp.slack.com/mcp",
          sign_in: ["oauth_client"],
          category: "mail_chat",
          ready: "later",
        },
        {
          id: "render",
          url: "https://mcp.render.com/mcp",
          sign_in: ["token"],
          category: "code",
          ready: "key",
          key_url: "https://dashboard.render.com/u/settings",
        },
        {
          id: "odd",
          url: "https://odd.example/mcp",
          sign_in: ["oauth"],
          category: "gardening",
          ready: "teleport",
          key_url: "javascript:alert(1)",
        },
        // An older Spade that doesn't say: its best way in.
        { id: "linear", url: "https://mcp.linear.app/mcp", sign_in: ["oauth", "token"] },
        { id: "hf", url: "https://huggingface.co/mcp", sign_in: ["token"] },
      ],
      connectors: [],
    }),
  );
  expect(
    read?.catalogue.map((entry) => [entry.id, entry.category, entry.ready, entry.keyUrl]),
  ).toEqual([
    ["slack", "mail_chat", "later", undefined],
    ["render", "code", "key", "https://dashboard.render.com/u/settings"],
    ["odd", "work", "later", undefined],
    ["linear", "work", "sign_in", undefined],
    ["hf", "work", "key", undefined],
  ]);
});

test("a failed sign-in says what fixes it, and a reason this client doesn't know reads as the general one", () => {
  const read = parseSpadeConnectors(
    JSON.stringify({
      catalogue: [],
      connectors: [
        { id: "linear", name: "Linear", state: "needs_reconnect", failed: "needs_admin" },
        { id: "notion", name: "Notion", state: "needs_reconnect", failed: "solar_flare" },
        { id: "sentry", name: "Sentry", state: "connected", last_used_ms: 5 },
      ],
    }),
  );
  expect(read?.connectors.map((each) => each.failed)).toEqual(["needs_admin", "failed", undefined]);
  expect(read?.connectors[2]?.lastUsedMs).toBe(5);
  expect(spadeSignInFailureWords("Linear", "needs_admin")).toBe(
    "Linear says your account needs admin approval. Ask your admin to allow Spade, then connect again.",
  );
  expect(spadeSignInFailureWords("Linear", "declined")).toBe(
    "The sign-in to Linear was cancelled. Connect again when you're ready.",
  );
});

test("when an app was last used reads in words", () => {
  const now = 10 * 86_400_000;
  expect(
    [undefined, now - 30_000, now - 5 * 60_000, now - 3 * 3_600_000, now - 86_400_000].map((at) =>
      spadeLastUsedWords(at, now),
    ),
  ).toEqual([
    "Not used yet",
    "Used just now",
    "Used 5 minutes ago",
    "Used 3 hours ago",
    "Used 1 day ago",
  ]);
});

const startKind = (url: string) =>
  parseSpadeConnectStart(JSON.stringify({ id: "local", sign_in_url: url }))?.kind;

test("a sign-in opens only over https, or over http on this machine for a server the person marked theirs", () => {
  expect(startKind("https://auth.example/authorize")).toBe("sign_in");
  expect(startKind("http://127.0.0.1:47821/authorize?x=1")).toBe("sign_in");
  expect(startKind("http://localhost:8080/authorize")).toBe("sign_in");
  expect(startKind("http://auth.example/authorize")).toBeUndefined();
  expect(startKind("http://127.0.0.1.evil.example/authorize")).toBeUndefined();
  expect(startKind("javascript:alert(1)")).toBeUndefined();
});
