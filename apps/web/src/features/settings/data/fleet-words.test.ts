import type { RemoteNetworks } from "@ace/protocol";
import { expect, test } from "vitest";
import {
  accountLine,
  directLine,
  fleetWarning,
  grantSummary,
  machineState,
  pathWordsFor,
  reachedThrough,
  transferLine,
} from "./fleet-words.ts";

const off = { state: "off" } as const;
const networks = (on: Partial<Record<keyof RemoteNetworks, string>>): RemoteNetworks => ({
  lan: on.lan ? { state: "on", address: on.lan } : off,
  tailscale: on.tailscale ? { state: "on", address: on.tailscale } : off,
  relay: on.relay ? { state: "on", address: on.relay } : off,
  account: on.account ? { state: "on", address: on.account } : off,
});

test.each([
  {
    input: { enabled: true, networks: networks({ lan: "https://l" }) },
    says: "Only devices on the same network can reach this computer. Sign in or turn on Tailscale to reach it from anywhere.",
  },
  {
    input: { enabled: true, networks: networks({}) },
    says: "Nothing can reach this computer yet. Turn on a network under Overview.",
  },
  {
    input: { enabled: false, networks: networks({ account: "wss://r" }) },
    says: "Remote access is off, so only this computer can open it.",
  },
])("Fleet warns under its title: $says", ({ input, says }) => {
  expect(fleetWarning(input)).toBe(says);
});

test("Fleet says nothing under its title once devices can reach this computer from anywhere, or while it loads", () => {
  expect(fleetWarning({ enabled: true, networks: networks({ account: "wss://r" }) })).toBe(
    undefined,
  );
  expect(
    fleetWarning({
      enabled: true,
      networks: networks({ tailscale: "https://t", lan: "https://l" }),
    }),
  ).toBe(undefined);
  expect(fleetWarning({ enabled: true, networks: undefined })).toBe(undefined);
});

test("this computer's row names every network that reaches it, and your own relay apart from ace's", () => {
  expect(
    reachedThrough(
      true,
      networks({ account: "wss://ace", tailscale: "https://t", lan: "https://l" }),
    ),
  ).toBe("Reached through your ace account, Tailscale and the local network");
  expect(reachedThrough(true, networks({ account: "wss://ace", relay: "wss://ace" }))).toBe(
    "Reached through your ace account",
  );
  expect(reachedThrough(true, networks({ relay: "wss://mine" }))).toBe(
    "Reached through your relay",
  );
  expect(reachedThrough(true, networks({}))).toBe("Nothing else can reach it yet");
  expect(reachedThrough(false, networks({ lan: "https://l" }))).toBe("Remote access is off");
});

test.each([
  { status: "online", failed: false, tone: "on", words: "Online" },
  { status: "machine_code", failed: false, tone: "warn", words: "Asks for its machine code" },
  { status: "offline", failed: true, tone: "off", words: "Offline · couldn't reach it" },
  { status: "offline", failed: false, tone: "off", words: "Offline" },
] as const)("a machine that is $status reads $words", ({ status, failed, tone, words }) => {
  expect(machineState(status, failed)).toEqual({ tone, words });
});

test("a network row says where it serves, why it doesn't, or how to turn it on", () => {
  expect(
    directLine("tailscale", true, { state: "on", address: "https://mac.tail.ts.net:4243" }),
  ).toEqual({ tone: "on", words: "On at mac.tail.ts.net:4243." });
  expect(
    directLine("lan", true, { state: "failed", error: "Couldn't listen on port 4243." }),
  ).toEqual({ tone: "warn", words: "Couldn't listen on port 4243." });
  expect(directLine("lan", false, off)).toEqual({
    tone: "off",
    words: "Off. Turn it on for devices on the same Wi-Fi.",
  });
});

test("the ace account row says who this computer is signed in as, or what signing in gives", () => {
  expect(accountLine({ email: "a@example.com", live: { state: "on" } }).words).toBe(
    "Signed in as a@example.com. Your devices open this computer from anywhere.",
  );
  expect(accountLine({ email: undefined, live: off }).tone).toBe("off");
  expect(
    accountLine({ email: "a@example.com", live: { state: "failed", error: "Relay refused it." } }),
  ).toEqual({ tone: "warn", words: "Relay refused it." });
});

test.each([
  {
    levels: {
      agents: "operate",
      browser: "operate",
      devices: "operate",
      screen: "off",
      commands: "off",
    },
    says: "Agents, browser and simulators. Not computer use or commands.",
  },
  {
    levels: { agents: "read", browser: "off", devices: "off", screen: "off", commands: "off" },
    says: "Agents (read only). Not browser, simulators, computer use or commands.",
  },
  {
    levels: {
      agents: "operate",
      browser: "operate",
      devices: "operate",
      screen: "operate",
      commands: "operate",
    },
    says: "Agents, browser, simulators, computer use and commands.",
  },
  {
    levels: { agents: "off", browser: "off", devices: "off", screen: "off", commands: "off" },
    says: "Nothing yet.",
  },
  { levels: undefined, says: "Differs between machines." },
] as const)("what other machines' agents may use reads: $says", ({ levels, says }) => {
  expect(grantSummary(levels)).toBe(says);
});

test("moving threads says whether work moves and whether ignored files go with it", () => {
  expect(transferLine({ on: true, ignored: true, differs: false })).toMatch(
    /ignored files like \.env go/,
  );
  expect(transferLine({ on: true, ignored: false, differs: false })).toMatch(
    /ignored files like \.env stay/,
  );
  expect(transferLine({ on: false, ignored: true, differs: false })).toMatch(/^Off\./);
  expect(transferLine({ on: true, ignored: true, differs: true })).toBe(
    "Differs between machines.",
  );
});

test("an online machine's row says which way it is reached right now", () => {
  expect(pathWordsFor("loopback")).toBe("on this computer");
  expect(pathWordsFor("lan")).toBe("over the local network");
  expect(pathWordsFor("tailscale")).toBe("over Tailscale");
  expect(pathWordsFor("relay")).toBe("through your relay");
  expect(pathWordsFor("account")).toBe("through your ace account");
  // A machine with a single way in says nothing more.
  expect(pathWordsFor(undefined)).toBeUndefined();
});
