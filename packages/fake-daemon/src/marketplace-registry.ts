import type {
  MarketPublishAction,
  MarketResult,
  RegistryAdmin,
  RegistryAdminEntry,
} from "@ace/protocol/marketplace";

/*
 * An organization's registry as its admins read it and withdraw from it through the daemon
 * (ADR 0206 amendment 5), as the fake daemon answers: each organization's registry seeded with
 * a signed skill and a held bot, read and withdrawn only with the person's grant for that one
 * call, as the daemon sends nothing with the machine's own. No market and no network.
 */

type RegistryAction = Extract<MarketPublishAction, { action: "registry" | "registryWithdraw" }>;

/** Whether a `publish` action is a registry's. */
export const isRegistryAction = (action: MarketPublishAction): action is RegistryAction =>
  action.action === "registry" || action.action === "registryWithdraw";

const hash = (seed: string) => seed.repeat(64).slice(0, 64);

function seeded(now: number): RegistryAdminEntry[] {
  // A test's clock may start near zero.
  const ago = (ms: number) => Math.max(0, now - ms);
  return [
    {
      type: "spade-skill",
      name: "triage-mail",
      title: "Triage mail",
      latest: "1.1.0",
      versions: [
        {
          version: "1.1.0",
          hash: hash("b"),
          size: 4_200,
          published: ago(86_400_000),
          status: "live",
          held: false,
          scan: { verdict: "pass", scanner: 1 },
        },
        {
          version: "1.0.0",
          hash: hash("a"),
          size: 3_900,
          published: ago(9 * 86_400_000),
          status: "live",
          held: false,
          scan: { verdict: "pass", scanner: 1 },
        },
      ],
    },
    {
      type: "spade-bot",
      name: "on-call",
      title: "On-call",
      versions: [
        {
          version: "0.2.0",
          hash: hash("c"),
          size: 12_800,
          published: ago(3_600_000),
          status: "waiting",
          held: true,
          scan: { verdict: "warn", scanner: 1 },
        },
      ],
    },
  ];
}

export class FakeRegistries {
  readonly #now: () => number;
  readonly #registries = new Map<string, RegistryAdminEntry[]>();
  /** What was asked, with the grant it came with, for tests. */
  readonly asked: { action: RegistryAction; personGrant: string | undefined }[] = [];

  constructor(now: () => number) {
    this.#now = now;
  }

  #entries(org: string): RegistryAdminEntry[] {
    let entries = this.#registries.get(org);
    if (!entries) {
      entries = seeded(this.#now());
      this.#registries.set(org, entries);
    }
    return entries;
  }

  answer(action: RegistryAction, personGrant: string | undefined): MarketResult {
    this.asked.push({ action, personGrant });
    if (!personGrant)
      return {
        op: "error",
        code: "person_grant",
        message: "Do this from an ace app you're signed in on.",
      };
    const entries = this.#entries(action.org);
    if (action.action === "registry") {
      const registry: RegistryAdmin = {
        org: action.org,
        publisher: { id: "pub_fakeorg", name: "acme" },
        // A copy, so a later withdrawal never changes an answer already sent.
        entries: entries.map((entry) => ({
          ...entry,
          versions: entry.versions.map((version) => ({ ...version })),
        })),
      };
      return { op: "publish", answer: { kind: "registry", registry } };
    }
    const version = entries
      .find((entry) => entry.type === action.type && entry.name === action.name)
      ?.versions.find((item) => item.version === action.version);
    if (!version || version.status === "blocked")
      return { op: "error", code: "not_found", message: "The market has nothing there." };
    version.withdrawal = { reason: action.reason, at: this.#now() };
    return { op: "publish", answer: { kind: "pending", what: "withdrawal" } };
  }
}
