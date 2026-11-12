import { FakeSpadeApi, type FakeDaemon } from "@ace/fake-daemon";
import { screen, waitFor, within } from "@testing-library/react";
import { expect } from "vitest";
import type { RouterHistory } from "@tanstack/react-router";
import { harness } from "./harness.tsx";

/**
 * The app with Spade turned on and running, its API a stateful fake at the daemon's `spade.*`
 * boundary. `machines`: other machines, each with a Spade of its own (`others`).
 */
export async function spadeApp(
  path: string,
  seed: (spade: FakeSpadeApi) => void,
  options: {
    machines?: { hostId: string; name: string; seed(spade: FakeSpadeApi): void }[];
    /** The router's history, for tests that move through it. */
    history?: RouterHistory;
    /** Stages the daemon before the app opens (requests it holds or fails). */
    daemon?(daemon: FakeDaemon): void;
  } = {},
) {
  const app = harness({
    clock: () => Date.now(),
    ...(options.machines ? { machines: options.machines } : {}),
    ...(options.history ? { history: options.history } : {}),
  });
  const spade = runningSpade(app.daemon);
  seed(spade);
  options.daemon?.(app.daemon);
  const others = new Map<string, FakeSpadeApi>();
  for (const machine of options.machines ?? []) {
    const daemon = app.machines.get(machine.hostId);
    if (!daemon) continue;
    const api = runningSpade(daemon);
    machine.seed(api);
    others.set(machine.hostId, api);
  }
  await app.open(path);
  // Spade is on: the global setting, as Settings › Spade turns it on.
  await waitFor(() => expect(app.client.state).toBe("ready"));
  await app.client.request({
    type: "settings.set",
    key: "spade.enabled",
    value: true,
    layer: { kind: "global" },
  });
  return { app, spade, others };
}

function runningSpade(daemon: FakeDaemon) {
  daemon.spade.status = { state: "ready", version: "0.6.0" };
  return new FakeSpadeApi(daemon.spade, () => Date.now());
}

/** An endpoint with a key and one saved model, as the person has after setting Spade up. */
export function withEndpoint(spade: FakeSpadeApi) {
  spade.endpoints.push({
    id: "openrouter",
    name: "OpenRouter",
    format: "openai-chat",
    base_url: "https://openrouter.ai/api/v1/",
    header_names: [],
    session_header: null,
    needs_key: true,
    key_set: true,
    key_source: "keychain",
    models: [{ id: "saved/model", name: "Saved model", source: "typed" }],
  });
  spade.liveModels.set("openrouter", [
    { id: "anthropic/sonnet", name: "Sonnet", context: 200_000, capabilities: ["images", "tools"] },
    { id: "meta/llama", name: "Llama", context: 128_000 },
  ]);
}

/** The Spade panel's list of bots. */
export async function roster() {
  return within(await screen.findByRole("navigation", { name: "Bots" }));
}

/** A bot's row in the panel, by the name it starts with. */
export async function botRow(name: string) {
  return (await roster()).findByRole("link", { name: new RegExp(`^${name}`) });
}
