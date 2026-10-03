// TODO(client-gaps): feat/client-protocol-gaps
/*
 * What main's protocol can't carry to a web client yet: decks (conductor run view), skills and
 * plugins, and file uploads (binary file channels). Each such
 * feature's single `*-source.ts` reads this fake backend in fake mode (dev:fake and tests) and
 * reports "unavailable" against a real daemon. Everything the protocol does carry goes through
 * `Client.request` in both modes, served in fake mode by @ace/fake-daemon's wire services.
 *
 * The fake daemon is loaded lazily so a production bundle never fetches it.
 */
import type { ClientApi } from "@ace/client";
import type { FakeConductor, FakeSkill } from "@ace/fake-daemon";
import { useClient } from "@ace/client-react";
import type { ChangedFile } from "@ace/ui-core";
import { useDaemonConnection } from "@/boot/connection.tsx";

type FakeModule = typeof import("@ace/fake-daemon");

/** Mutable fake state for one client, so it survives navigation and is isolated per test. */
export interface FakeBackend {
  readonly fake: FakeModule;
  readonly conductor: FakeConductor;
  now(): number;
  skills: FakeSkill[];
  /** Files uploaded this session (uploads have no wire protocol yet). */
  files: (ChangedFile & { text: string })[];
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
      files: [],
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
