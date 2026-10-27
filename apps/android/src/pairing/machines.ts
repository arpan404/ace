import { MachineDirectory, type MachineEntry, type PairedMachine } from "@ace/client/machines";
import type { Storage } from "@ace/client";
import {
  redeemConfirmedPairing,
  PairingFlowError,
  type ConfirmedPairing,
  type PairingTransport,
} from "./pairing-flow.ts";
import type { CredentialStore } from "./credentials.ts";

/**
 * Paired-machine directory binding for Android production pairing.
 *
 * Owns the non-secret machine list through the shared `MachineDirectory`
 * (duplicate-pairing rejection, serialized metadata writes, recovery that
 * drops malformed rows) while device tokens live only in the injected
 * credential store. Rules, aligned with the iOS `MachinesModel`:
 *
 * - Pairing adds the token and the entry together. `MachineDirectory.add`
 *   writes the secret first and removes it again if the metadata save
 *   fails, so a failed pair never leaves a usable credential behind.
 * - Removal delegates to `MachineDirectory.remove`, which serializes the
 *   load, deletes the credential first, then the metadata. A failed
 *   metadata write leaves a visible entry whose token is already gone,
 *   so it routes to pairing again rather than connecting. Removal here
 *   performs no separate lookup or credential delete of its own: those
 *   would run outside the directory's serialization (a TOCTOU window for
 *   a concurrent pair/rename) and would delete the credential twice.
 * - The host identity comes from the authenticated pairing flow, never
 *   from the link hostname.
 *
 * This module performs no networking and opens no database itself. Storage
 * is injected (production passes the per-namespace SQLite adapter;
 * one owner per daemon/device namespace). Grant persistence beyond the
 * directory (the iOS `grants` map) is later settings work; denial of
 * unauthorized actions is enforced at admission time by the SDK.
 */

export interface PairingMachines {
  load(): Promise<readonly MachineEntry[]>;
  pair(
    confirmed: ConfirmedPairing,
    deviceName: string,
    transport: PairingTransport,
    signal?: AbortSignal | undefined,
  ): Promise<MachineEntry>;
  remove(hostId: string): Promise<void>;
  rename(hostId: string, displayName: string): Promise<void>;
}

export function createPairingMachines(input: {
  storage: Storage;
  credentials: CredentialStore;
}): PairingMachines {
  const credentials = input.credentials;
  const directory = new MachineDirectory(input.storage, {
    get: (key) => credentials.get(key),
    set: (key, token) => credentials.set(key, token),
    delete: (key) => credentials.remove(key),
  });
  return {
    load: () => directory.load(),
    async pair(confirmed, deviceName, transport, signal) {
      const paired = await redeemConfirmedPairing(confirmed, deviceName, transport, signal);
      // The code is already burned once redeem resolves: an abort racing the
      // directory write must surface `consumed` guidance (check the
      // computer's devices, mint a fresh link) instead of a retryable error
      // that implies the link is still valid or a silent background add the
      // UI never shows. This covers aborts that fired *before* the save
      // starts. An abort firing *during* `directory.add` cannot cancel it:
      // `MachineDirectory.add` takes no signal and the save is serialized,
      // so the entry still lands and is returned as success. Callers must
      // not treat that late abort as an undo — success means saved.
      if (signal?.aborted) {
        throw new PairingFlowError(
          "consumed",
          "Pairing used this link but was cancelled before saving. " +
            "Check the computer's devices for an unused entry and remove it, then create a new link.",
        );
      }
      try {
        return await directory.add(paired satisfies PairedMachine);
      } catch (error) {
        throw mapDirectoryFailure(error);
      }
    },
    async remove(hostId) {
      try {
        await directory.remove(hostId);
      } catch (error) {
        throw mapDirectoryFailure(error);
      }
    },
    async rename(hostId, displayName) {
      const name = displayName.trim();
      if (name === "")
        throw new PairingFlowError("invalid-name", "Name this machine with 1 to 256 characters.");
      try {
        await directory.rename(hostId, Array.from(name).slice(0, 256).join(""));
      } catch (error) {
        throw mapDirectoryFailure(error);
      }
    },
  };
}

function mapDirectoryFailure(error: unknown): Error {
  if (error instanceof PairingFlowError) return error;
  if (error instanceof Error) {
    if (/already paired/i.test(error.message)) {
      return new PairingFlowError(
        "auth",
        "This machine is already paired. The used link minted an extra device entry: " +
          "remove the duplicate on your computer, then remove this machine here before pairing again.",
      );
    }
    if (/unknown machine/i.test(error.message)) {
      return new PairingFlowError("daemon", "This machine is no longer paired.");
    }
    if (/unavailable|storage|credential/i.test(error.message)) {
      return new PairingFlowError(
        "daemon",
        "The device credential could not be updated. Check the device lock state and try again.",
      );
    }
  }
  return new PairingFlowError("daemon", "The machine list could not be updated. Try again.");
}
