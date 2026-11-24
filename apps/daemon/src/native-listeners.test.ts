// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import type { MainSocket } from "./main-socket.ts";
import { ownReservations, type NativeUpgrade } from "./native-upgrade.ts";
import {
  closeNativeSockets,
  unwindNativeListeners,
  type StartedNativeLoopback,
} from "./native-listeners.ts";
import { PreAuthAdmission } from "./socket-admission.ts";

/** A pre-auth budget the tests choose; no timer ever fires. */
function admission(perAddress = 1): PreAuthAdmission {
  return new PreAuthAdmission({ perAddress }, () => () => {});
}

/** One upgrade answer that takes a reservation from `preAuth`, as a listener's admit does. */
function upgrades(preAuth: PreAuthAdmission, listener: "local" | "remote"): NativeUpgrade {
  return {
    async admit(request) {
      return {
        decision: "accept",
        reservation: preAuth.reserve(listener, request.address),
      };
    },
    release: (reservation) => preAuth.release(reservation),
    opened: () => {},
  };
}

/** A main socket stub, only what `track` and the sweeps touch. */
function mainSocket(): MainSocket {
  return {
    readyState: 1,
    bufferedAmount: 0,
    isPaused: false,
    send: () => {},
    close: () => {},
    terminate: () => {},
    pause: () => {},
    resume: () => {},
    on: () => {},
    once: () => {},
    off: () => {},
  };
}

const ask = (address: string) => ({ id: 1, target: "/", origin: null, address });

describe("a listener's reservations", () => {
  it("closing the loopback leaves a remote upgrade's reservation and address charge held", async () => {
    const preAuth = admission();
    const loopback = ownReservations(upgrades(preAuth, "local"));
    const remote = ownReservations(upgrades(preAuth, "remote"));
    await loopback.admit(ask("127.0.0.1"));
    const held = await remote.admit(ask("10.0.0.9"));
    expect(preAuth.reserved).toBe(2);
    expect(preAuth.admits("remote", "10.0.0.9")).toBe(false);

    // The loopback listener closes while the remote upgrade is still on the wire.
    loopback.releaseHeld();
    expect(preAuth.reserved).toBe(1);

    // The remote upgrade registers afterwards: the original address is still charged.
    preAuth.track(mainSocket(), "remote", "", held.reservation);
    expect(preAuth.reserved).toBe(0);
    expect(preAuth.admits("remote", "10.0.0.9")).toBe(false);
  });

  it("releases only the reservations its own listener still holds", async () => {
    const preAuth = admission();
    const loopback = ownReservations(upgrades(preAuth, "local"));
    const remote = ownReservations(upgrades(preAuth, "remote"));
    await loopback.admit(ask("127.0.0.1"));
    await remote.admit(ask("10.0.0.9"));

    remote.releaseHeld();
    expect(preAuth.reserved).toBe(1);
    expect(preAuth.admits("remote", "10.0.0.9")).toBe(true);

    loopback.releaseHeld();
    expect(preAuth.reserved).toBe(0);
    expect(preAuth.admits("local", "127.0.0.1")).toBe(true);
  });
});

describe("unwinding only native listeners", () => {
  it("does not close the sockets of a remote listener Rust does not serve", async () => {
    const closed: MainSocket[] = [];
    const loopback = mainSocket();
    const tsRemote = mainSocket();
    const listener: StartedNativeLoopback = {
      port: 1,
      internalHttpUrl: "http://127.0.0.1:1",
      close: async () => {},
    };
    await unwindNativeListeners(
      { loopback: listener },
      { loopback: new Set([loopback]), remote: new Set([tsRemote]) },
      (socket) => closed.push(socket),
    );
    expect(closed).toEqual([loopback]);
  });

  it("closes a native remote listener's sockets too", () => {
    const remote = mainSocket();
    const closed: MainSocket[] = [];
    closeNativeSockets(
      { loopback: undefined, remote: { port: 2, close: async () => {} } },
      { loopback: new Set(), remote: new Set([remote]) },
      (socket) => closed.push(socket),
    );
    expect(closed).toEqual([remote]);
  });
});
