import { describe, expect, it } from "vitest";
import { MachineCall, type InteractionRequest } from "@ace/protocol";
import {
  capabilityOf,
  decide,
  effectiveGrants,
  grantsFor,
  type CallFacts,
  type GrantFacts,
} from "./grant-rules.ts";

const everythingOn = {
  agents: "operate",
  browser: "operate",
  devices: "operate",
  screen: "operate",
  commands: "operate",
} as const;
const facts = (master: GrantFacts["master"]): GrantFacts => ({
  master,
  grants: grantsFor(master, everythingOn),
  pairing: "operate",
  ceiling: "operate",
});

describe("this machine's switch is a ceiling on every capability", () => {
  it("read lets no capability act, even one the person set to Read and act", () => {
    expect(effectiveGrants(facts("read"))).toEqual({
      agents: "read",
      browser: "read",
      devices: "read",
      screen: "read",
      commands: "read",
    });
    for (const capability of ["devices", "screen", "commands"] as const) {
      expect(decide(capability, "read", facts("read"))).toEqual({ allow: true, level: "read" });
      expect(decide(capability, "operate", facts("read"))).toMatchObject({
        allow: false,
        code: "machine_forbidden",
        message: expect.stringContaining("only read"),
      });
    }
  });
  it("operate lets each grant apply as set", () => {
    const set = { ...facts("operate"), grants: grantsFor("operate", { screen: "read" }) };
    expect(decide("commands", "operate", facts("operate"))).toMatchObject({ allow: true });
    expect(decide("screen", "operate", set)).toMatchObject({ allow: false });
    expect(decide("devices", "operate", set)).toMatchObject({ allow: true });
  });
  it("off closes the machine whatever the grants say", () => {
    expect(decide(undefined, "read", facts("off"))).toMatchObject({
      allow: false,
      code: "machine_opted_out",
    });
  });
});

describe("the capability a call on a guest session needs", () => {
  const pending = new Map<string, InteractionRequest>([
    ["help", { kind: "browser_help", tabId: "tab-1", reason: "login", message: "Sign in" }],
    [
      "tap",
      {
        kind: "approval",
        title: "Tap",
        options: [],
        target: { tool: "sim_tap", access: "execute" },
      },
    ],
    ["question", { kind: "question", questions: [] }],
  ]);
  const session: CallFacts = {
    guest: (threadId) => threadId === "session",
    request: (_threadId, id) => pending.get(id),
  };
  const respond = (interactionId: string) =>
    MachineCall.parse({
      op: "respond",
      threadId: "session",
      interactionId,
      resolution: { kind: "approval", optionId: "yes" },
    });
  const only = (capability: "browser" | "devices") => ({
    ...facts("operate"),
    grants: grantsFor("operate", {
      agents: "off",
      browser: capability === "browser" ? "operate" : "off",
      devices: capability === "devices" ? "operate" : "off",
    }),
  });

  it("an answer needs the capability whose tool asked, not any guest capability", () => {
    // Simulators on, browser off: the browser's request can't be answered from there.
    expect(
      decide(capabilityOf(respond("help"), session), "operate", only("devices")),
    ).toMatchObject({ allow: false, message: expect.stringContaining("Browser is off") });
    expect(
      decide(capabilityOf(respond("help"), session), "operate", only("browser")),
    ).toMatchObject({ allow: true });
    expect(decide(capabilityOf(respond("tap"), session), "operate", only("browser"))).toMatchObject(
      { allow: false },
    );
    expect(decide(capabilityOf(respond("tap"), session), "operate", only("devices"))).toMatchObject(
      { allow: true },
    );
  });
  it("a request no capability raised can't be answered from another machine", () => {
    expect(
      decide(capabilityOf(respond("question"), session), "operate", facts("operate")),
    ).toMatchObject({ allow: false });
  });
  it("status with no threads is an Agents call, not a guest one", () => {
    // The wire asks for at least one; the rule must not lean on that.
    const status: MachineCall = { op: "status", threadIds: [] };
    const browserOnly = only("browser");
    expect(decide(capabilityOf(status, session), "read", browserOnly)).toMatchObject({
      allow: false,
      message: expect.stringContaining("Agents is off"),
    });
  });
});
