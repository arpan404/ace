import { describe, expect, test } from "vitest";
import {
  emptySpadeConversation,
  foldSpade,
  parseSpadeGrant,
  spadeGrantSentence,
  parseSpadeBotSecurity,
  parseSpadeLiveFrame,
  parseSpadeSecurityMachine,
  spadeBubbles,
  spadeView,
  type SpadeConversationState,
} from "./index.ts";

function asked(event: Record<string, unknown>) {
  const state: SpadeConversationState = emptySpadeConversation();
  let seq = 0;
  const stored = (body: Record<string, unknown>) => {
    const input = parseSpadeLiveFrame(
      "stored",
      JSON.stringify({ seq: ++seq, at: 1000, event: body }),
    );
    if (input) foldSpade(state, input);
  };
  stored({ type: "reply_started", reply: "r1" });
  stored({ type: "approval_requested", reply: "r1", call_id: "c1", name: "shell", ...event });
  const view = spadeView(state);
  return spadeBubbles(view).find((bubble) => bubble.kind === "ask");
}

describe("what Spade asked about (ADR 0171)", () => {
  test.each([
    ["outside_sandbox", "outside_sandbox"],
    ["undeclared", "undeclared"],
    ["drive", "drive"],
  ])("a request asked as %s carries it to its bubble", (ask, expected) => {
    expect(asked({ ask, arguments: { command: "ls" } })).toMatchObject({ ask: expected });
  });

  test("a driving step carries the app it offers to allow, and only a driving step does", () => {
    expect(asked({ ask: "drive", app: "com.apple.TextEdit" })).toMatchObject({
      ask: "drive",
      app: "com.apple.TextEdit",
    });
    const outside = asked({ ask: "outside_sandbox", app: "com.apple.TextEdit" });
    expect(outside && "app" in outside).toBe(false);
    const sensitive = asked({ ask: "drive" });
    expect(sensitive && "app" in sensitive).toBe(false);
  });

  test.each([[{}], [{ ask: null }], [{ ask: "something_new" }]])(
    "a request with no usable ask (%j) still folds, as before",
    (extra) => {
      const bubble = asked(extra);
      expect(bubble).toMatchObject({ kind: "ask", callId: "c1" });
      expect(bubble && "ask" in bubble).toBe(false);
    },
  );
});

describe("a drive grant (ADR 0171, amendment 3)", () => {
  test.each([
    [{ kind: "drive_app", app: "com.apple.TextEdit" }, "Act in the app com.apple.TextEdit"],
    [{ kind: "drive_site", host: "github.com" }, "Act on github.com"],
  ])("an app grant and a site grant read as what they are (%j)", (scope, words) => {
    const grant = parseSpadeGrant({ id: "g1", by: "person", created_at: 1, ...scope });
    expect(grant).toMatchObject(scope);
    expect(grant && spadeGrantSentence(grant)).toContain(words);
  });

  test("the same words as an app and as a site stay two kinds", () => {
    const app = parseSpadeGrant({ id: "g1", by: "person", kind: "drive_app", app: "github.com" });
    const site = parseSpadeGrant({
      id: "g2",
      by: "person",
      kind: "drive_site",
      host: "github.com",
    });
    expect(app?.kind).toBe("drive_app");
    expect(site?.kind).toBe("drive_site");
    expect(app && spadeGrantSentence(app)).not.toBe(site && spadeGrantSentence(site));
  });
});

describe("the machine's security answer", () => {
  const policy = { mode: "off", allow: ["a.dev"], dropped: [] };
  test("reads the defaults every bot inherits", () => {
    const machine = parseSpadeSecurityMachine(
      JSON.stringify({
        bots: { commands: "outside", network: policy, plugin_network: { mode: "open" } },
      }),
    );
    expect(machine?.bots).toEqual({
      commands: "outside",
      network: policy,
      pluginNetwork: { mode: "open", allow: [], dropped: [] },
    });
  });

  test("an older Spade without bots reads as sandboxed commands", () => {
    expect(parseSpadeSecurityMachine("{}")?.bots.commands).toBe("sandboxed");
  });
});

describe("a bot's security answer", () => {
  test("reads which settings are its own", () => {
    const bot = parseSpadeBotSecurity(
      JSON.stringify({
        commands: "outside",
        own: { commands: false, network: true, plugin_network: false },
      }),
    );
    expect(bot).toMatchObject({
      commands: "outside",
      own: { commands: false, network: true, pluginNetwork: false },
    });
  });

  test("an older Spade without own reads everything as the bot's own", () => {
    expect(parseSpadeBotSecurity("{}")).toMatchObject({
      commands: "sandboxed",
      own: { commands: true, network: true, pluginNetwork: true },
    });
  });
});
