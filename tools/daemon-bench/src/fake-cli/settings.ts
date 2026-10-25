import { resolve } from "node:path";

/** What the fake CLI replays, read once from its environment. */
export interface FakeSettings {
  /** Directory of recordings for this provider, e.g. `fixtures/claude/2.1.286`. */
  fixtures: string;
  /** Recording replayed when the user's text names none. */
  fixture: string;
  /** Recorded gaps are divided by this; 0 replays with no pauses. */
  speed: number;
  /** Pause before each synthetic long-text delta. */
  deltaMs: number;
}
const number = (value: string | undefined, fallback: number) => {
  const parsed = Number(value);
  return value !== undefined && Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
};
export function readSettings(env: NodeJS.ProcessEnv, provider: string): FakeSettings {
  const fixtures = env["ACE_FAKE_CLI_FIXTURES"];
  if (!fixtures) throw new Error(`ACE_FAKE_CLI_FIXTURES must name the ${provider} recordings`);
  return {
    fixtures: resolve(fixtures),
    fixture: env["ACE_FAKE_CLI_FIXTURE"] || "tool-read",
    speed: number(env["ACE_FAKE_CLI_SPEED"], 20),
    deltaMs: number(env["ACE_FAKE_CLI_DELTA_MS"], 1),
  };
}
