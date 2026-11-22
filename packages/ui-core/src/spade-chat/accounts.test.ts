import { describe, expect, test } from "vitest";
import {
  parseSpadeModels,
  parseSpadeSignInFlow,
  spadeAccountWords,
  spadeEndpointUsable,
  spadeFirstUsableModel,
  spadeModelGroups,
  spadeModelLabel,
  spadeModelState,
  spadeProviderGroups,
  spadeUsedByWords,
  type SpadeEndpoint,
} from "./index.ts";

const models = (body: unknown) => {
  const parsed = parseSpadeModels(JSON.stringify(body));
  if (!parsed) throw new Error("no models");
  return parsed;
};

const chatgpt = (signedIn: boolean) => ({
  id: "chatgpt",
  name: "ChatGPT",
  provider: "openai",
  auth: "chatgpt",
  account: { email: "sam@example.com", plan: "plus", signed_in: signedIn },
  used_by: ["Ledger", "Inbox"],
  models: [{ id: "gpt-5.5" }],
});

const endpoint = (raw: Record<string, unknown>): SpadeEndpoint => {
  const [read] = models({ endpoints: [raw] }).endpoints;
  if (!read) throw new Error("no endpoint");
  return read;
};

describe("accounts of a provider", () => {
  test("an older Spade's endpoints still read: a key if it needed one, no provider, no bots", () => {
    const read = models({
      endpoints: [
        { id: "openrouter", needs_key: true, key_set: true },
        { id: "ollama", needs_key: false },
      ],
    });
    expect(
      read.endpoints.map(({ auth, provider, account, usedBy }) => ({
        auth,
        provider,
        account,
        usedBy,
      })),
    ).toEqual([
      { auth: "key", provider: undefined, account: undefined, usedBy: [] },
      { auth: "none", provider: undefined, account: undefined, usedBy: [] },
    ]);
    expect(read.signIn).toEqual([]);
  });

  test("a ChatGPT sign-in reads who it is and which bots use it", () => {
    const read = models({ endpoints: [chatgpt(true)], sign_in: ["chatgpt", 4] });
    expect(read.signIn).toEqual(["chatgpt"]);
    const [account] = read.endpoints;
    expect(account?.account).toEqual({ email: "sam@example.com", plan: "plus", signedIn: true });
    expect(account && spadeAccountWords(account, true)).toBe("Signed in as sam@example.com · Plus");
    expect(spadeUsedByWords(account?.usedBy ?? [])).toBe("Used by Ledger and Inbox");
  });

  test("a signed-out ChatGPT account can't answer, and isn't a new bot's first model", () => {
    const out = endpoint(chatgpt(false));
    expect(spadeAccountWords(out, true)).toBe("Signed out");
    expect(spadeEndpointUsable(out)).toBe(false);
    expect(spadeModelState("chatgpt/gpt-5.5", [out])).toBe("none");
    expect(spadeFirstUsableModel([out])).toBeUndefined();
    expect(spadeModelState("chatgpt/gpt-5.5", [endpoint(chatgpt(true))])).toBe("ready");
  });

  test("a ChatGPT account Spade doesn't vouch for reads as signed out", () => {
    expect(spadeAccountWords(endpoint({ ...chatgpt(true), account: null }), true)).toBe(
      "Signed out",
    );
  });

  test("accounts group under their provider in the order the first of each comes", () => {
    const read = models({
      endpoints: [
        { id: "openai", name: "Personal", provider: "openai", auth: "key", needs_key: true },
        { id: "ollama", name: "Ollama", provider: null, auth: "none" },
        { id: "go", name: "OpenCode Go", provider: "opencode-go", auth: "key", needs_key: true },
        chatgpt(true),
      ],
      presets: [
        { id: "opencode-go", name: "OpenCode Go (OpenAI format)" },
        { id: "openai", name: "OpenAI" },
      ],
    });
    expect(
      spadeProviderGroups(read.endpoints, read.presets).map((group) => [
        group.name,
        group.accounts.map((account) => account.id),
      ]),
    ).toEqual([
      ["OpenAI", ["openai", "chatgpt"]],
      ["Ollama", ["ollama"]],
      ["OpenCode Go", ["go"]],
    ]);
  });

  test("two accounts of one name are told apart in the model picker", () => {
    const personal = endpoint({ id: "openai", name: "OpenAI", models: [{ id: "gpt-5.5" }] });
    const work = endpoint({ id: "work", name: "OpenAI", models: [{ id: "gpt-5.5" }] });
    const sources = {
      endpoints: [personal, work].map((each) => ({ endpoint: each, models: each.models })),
      subscriptions: [],
    };
    expect(spadeModelGroups(sources, "").map((group) => group.label)).toEqual([
      "OpenAI (openai)",
      "OpenAI (work)",
    ]);
    expect(spadeModelLabel(sources, "work/gpt-5.5").source).toBe("OpenAI (work)");
  });
});

describe("signing in to ChatGPT", () => {
  test("a device sign-in reads its link and code while it waits", () => {
    expect(
      parseSpadeSignInFlow(
        JSON.stringify({
          flow: {
            id: "f1",
            method: "device",
            state: "waiting",
            url: "https://auth.openai.com/codex/device",
            user_code: "ABCD-1234",
            endpoint: null,
            error: null,
          },
        }),
      ),
    ).toEqual({
      id: "f1",
      method: "device",
      state: "waiting",
      url: "https://auth.openai.com/codex/device",
      userCode: "ABCD-1234",
      endpoint: undefined,
      error: undefined,
    });
  });

  test("a finished sign-in carries the account it signed in", () => {
    const flow = parseSpadeSignInFlow(
      JSON.stringify({
        flow: { id: "f1", method: "browser", state: "done", endpoint: chatgpt(true) },
      }),
    );
    expect(flow?.endpoint?.account?.email).toBe("sam@example.com");
  });

  test("an answer without a flow doesn't read as one", () => {
    expect(parseSpadeSignInFlow(JSON.stringify({ error: "no" }))).toBeUndefined();
  });
});
