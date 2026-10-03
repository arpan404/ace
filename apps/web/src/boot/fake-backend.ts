// TODO(train-2): wire to protocol when merged
/*
 * The daemon on this branch has no wire reads for decks, accounts, files, search, skills or
 * slash commands yet. Each feature's `*-source.ts` reads from this fake backend in fake mode
 * (dev:fake and tests) and reports "unavailable" against a real daemon, so wiring a protocol
 * later changes only that feature's source file.
 *
 * The fake daemon is loaded lazily so a production bundle never fetches it.
 */
import type { ClientApi } from "@ace/client";
import type {
  FakeAccount,
  FakeChangedFile,
  FakeConductor,
  FakeSchedulingPolicy,
  FakeSkill,
} from "@ace/fake-daemon";
import { useClient } from "@ace/client-react";
import { useDaemonConnection } from "@/boot/connection.tsx";

type FakeModule = typeof import("@ace/fake-daemon");

/** Mutable fake state for one client, so it survives navigation and is isolated per test. */
export interface FakeBackend {
  readonly fake: FakeModule;
  readonly conductor: FakeConductor;
  now(): number;
  skills: FakeSkill[];
  accounts: FakeAccount[];
  policy: FakeSchedulingPolicy;
  files: FakeChangedFile[];
}

const backends = new WeakMap<ClientApi, Promise<FakeBackend>>();

// Wall-clock time is the boundary here: fixtures are laid out relative to "now".
const now = () => Date.now();

function load(): Promise<FakeBackend> {
  return import("@ace/fake-daemon").then((fake) => {
    return {
      fake,
      conductor: new fake.FakeConductor({ clock: now }),
      now,
      skills: fake.skillCatalog(),
      accounts: fake.accountList(now()),
      policy: fake.defaultSchedulingPolicy(),
      files: fake.changedFiles(now()),
    };
  });
}

export function fakeBackend(client: ClientApi): Promise<FakeBackend> {
  let backend = backends.get(client);
  if (!backend) {
    backend = load();
    backends.set(client, backend);
  }
  return backend;
}

/** The fake backend for this window, or null when talking to a real daemon. */
export function useFakeBackend(): Promise<FakeBackend> | null {
  const client = useClient();
  const { mode } = useDaemonConnection();
  return mode === "fake" ? fakeBackend(client) : null;
}

/** Thrown by sources when the connected daemon cannot serve a feature yet. */
export class UnavailableError extends Error {
  constructor(feature: string) {
    super(`${feature} isn't available from this daemon yet.`);
    this.name = "UnavailableError";
  }
}
