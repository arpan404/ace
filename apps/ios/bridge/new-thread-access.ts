import type { ClientCore } from "@ace/client";
import { AccessMode, ProviderKind, type AccessModeOffer } from "@ace/protocol";
import { accessChoices, newThreadAccess, providerNames, type NewThreadAccess } from "@ace/ui-core";
import { z } from "zod";
import type { PatchSink } from "./agents.ts";

/*
 * New thread's access mode, as the web's New thread decides it (`newThreadAccess`): the draft's
 * choice, else the project's default, else this daemon's, run as the nearest mode the provider
 * supports and never a looser one. The bridge reads the daemon's default once per sheet and each
 * provider account's modes (`permissions.capabilities`) when it is chosen; Swift draws the
 * choices it is sent and sends back the mode picked.
 */

export type AccessOwner = Pick<ClientCore, "request">;

/** What the sheet has chosen so far that access depends on. */
export interface AccessTarget {
  provider: ProviderKind | undefined;
  account: string | undefined;
  chosen: AccessMode | undefined;
  projectDefault: AccessMode | undefined;
}

const quiet = { timeoutMs: 15_000 };
const SettingEntries = z.object({
  entries: z.array(z.object({ key: z.string(), value: z.unknown() })),
});
type Offers = { state: "loading" | "ready" | "failed"; offers: readonly AccessModeOffer[] };

export class NewThreadAccessReader {
  #owner: AccessOwner;
  #sink: PatchSink;
  #daemonDefault: AccessMode | undefined;
  #offers = new Map<string, Promise<Offers> | Offers>();
  #target: AccessTarget = {
    provider: undefined,
    account: undefined,
    chosen: undefined,
    projectDefault: undefined,
  };
  #generation = 0;
  constructor(owner: AccessOwner, sink: PatchSink) {
    this.#owner = owner;
    this.#sink = sink;
  }

  /** The sheet opened: read this daemon's default for new threads again. */
  async open(): Promise<void> {
    this.#offers.clear();
    try {
      const reply = await this.#owner.request(
        { type: "settings.get", key: "access.defaultMode", scope: {} },
        quiet,
      );
      const entry = SettingEntries.parse(reply).entries.find(
        (candidate) => candidate.key === "access.defaultMode",
      );
      const mode = AccessMode.safeParse(entry?.value);
      this.#daemonDefault = mode.success ? mode.data : undefined;
    } catch {
      this.#daemonDefault = undefined;
    }
    void this.target(this.#target);
  }

  /** The provider, account, project or picked mode changed: say what the thread runs at. */
  async target(target: AccessTarget): Promise<void> {
    this.#target = target;
    const generation = ++this.#generation;
    const read = this.#read(target.provider, target.account);
    if (read instanceof Promise) {
      this.#emit({ state: "loading", offers: [] });
      const settled = await read;
      if (generation === this.#generation) this.#emit(settled);
      return;
    }
    this.#emit(read);
  }

  /** Access for the create, from what was read; offers not read yet leave it to the daemon. */
  decide(target: AccessTarget): NewThreadAccess {
    const read = this.#read(target.provider, target.account);
    return this.#decided(target, read instanceof Promise ? [] : read.offers);
  }

  #decided(target: AccessTarget, offers: readonly AccessModeOffer[]): NewThreadAccess {
    return newThreadAccess({
      chosen: target.chosen,
      projectDefault: target.projectDefault,
      daemonDefault: this.#daemonDefault,
      offers,
      provider: target.provider ? providerNames[target.provider] : undefined,
    });
  }

  #read(provider: ProviderKind | undefined, account: string | undefined): Promise<Offers> | Offers {
    if (!provider) return { state: "ready", offers: [] };
    const key = `${provider}\u0000${account ?? ""}`;
    const known = this.#offers.get(key);
    if (known) return known;
    const reading = this.#owner
      .request(
        {
          type: "permissions.capabilities",
          provider,
          ...(account ? { instanceId: account } : {}),
        },
        quiet,
      )
      .then((reply): Offers => {
        if (!reply.ok) throw new Error(reply.error ?? "unavailable");
        return { state: "ready", offers: reply.accessModes ?? [] };
      })
      .catch((): Offers => ({ state: "failed", offers: [] }))
      .then((settled) => {
        // A failed read is asked again the next time this account is chosen.
        if (settled.state === "failed") this.#offers.delete(key);
        else this.#offers.set(key, settled);
        return settled;
      });
    this.#offers.set(key, reading);
    return reading;
  }

  #emit(read: Offers): void {
    const target = this.#target;
    const decided = this.#decided(target, read.offers);
    this.#sink.put("compose:access", () => ({
      type: "compose.access",
      provider: target.provider ?? null,
      state: read.state,
      choices: accessChoices(read.offers),
      selected: decided.admitted ?? null,
      label: decided.summary?.label ?? null,
      stricter: decided.summary?.stricter ?? null,
      problem: decided.problem ?? null,
    }));
  }
}

/** A provider the sheet named, when it is one ace knows. */
export function knownProvider(provider: string | undefined): ProviderKind | undefined {
  const parsed = ProviderKind.safeParse(provider);
  return parsed.success ? parsed.data : undefined;
}
