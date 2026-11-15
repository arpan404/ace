import { HelloConfirm, HelloEarly, type DeviceId } from "@ace/protocol";
import type { HostChannel, NkAccepted, NkHost } from "@ace/relay";
import type { MachineAccount } from "../account-access/machine-account.ts";
import type { Devices, PairedDevice, SessionActor } from "../devices.ts";
import { accountHello, mainActor } from "../relay-hello.ts";
import type { RemoteAuth } from "../remote-auth.ts";
import type { NkAdmission, NkSession } from "./admission.ts";

/*
 * The daemon's half of a relay stream opened with Noise NK (ADR 0155, step 2). A first message
 * is admitted only through `NkAdmission`'s steps, and the credential check records nothing: a
 * ticket is consumed (one synchronous check-and-delete, so one of two racing copies gets it),
 * a grant is checked without a machine code. The session it opens is unconfirmed until the
 * client's `hello.confirm`; only then does the device count as seen, its install fold and its
 * link hold.
 */

/** An admitted NK main channel, handed to the main-socket handler before it confirms. */
export type EarlyMain = {
  channel: HostChannel;
  early: HelloEarly;
  actor: SessionActor;
  session: NkSession;
  /** For an account device: whether it still holds access. */
  stillAdmitted?: (() => boolean) | undefined;
  account?: string | undefined;
  grantExpiresAt?: number | undefined;
  /** The client's confirmation once its device effects ran, or undefined when it never came. */
  confirmed: Promise<HelloConfirm | undefined>;
};

export type NkHostOptions = {
  admission: NkAdmission;
  /** The host key epoch tickets are bound to: the daemon's relay host id. */
  epoch: string;
  auth: RemoteAuth;
  devices: Devices;
  account?: Pick<MachineAccount, "admitDevice" | "status" | "stillAdmitted"> | undefined;
  serve(entry: EarlyMain): void | Promise<void>;
};

type Credential = {
  actor: SessionActor;
  paired?: PairedDevice;
  stillAdmitted?: () => boolean;
  account?: string;
  grantExpiresAt?: number;
};

const decoder = new TextDecoder("utf-8", { fatal: true });

function parseEarly(payload: Uint8Array): HelloEarly | undefined {
  try {
    const parsed = HelloEarly.safeParse(JSON.parse(decoder.decode(payload)));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

export function nkHost(options: NkHostOptions): NkHost {
  const { admission } = options;
  async function credential(early: HelloEarly): Promise<Credential | undefined> {
    if (early.ticket !== undefined) {
      const device = options.auth.consumeEarly(early.ticket, options.epoch);
      if (!device || device.id !== early.deviceId) return undefined;
      const actor = mainActor(device, undefined, options);
      return actor ? { actor, paired: device } : undefined;
    }
    if (early.grant === undefined) return undefined;
    // No machine code here: a machine that asks for one is answered by refusing NK, and the
    // client's XX attempt carries the code as today.
    const admitted = await accountHello({ deviceId: early.deviceId }, early.grant, options.account);
    if (!admitted.device || !admitted.stillAdmitted) return undefined;
    const actor = mainActor({ id: early.deviceId }, admitted.stillAdmitted, options);
    if (!actor) return undefined;
    return {
      actor,
      stillAdmitted: admitted.stillAdmitted,
      ...(admitted.account === undefined ? {} : { account: admitted.account }),
      ...(admitted.grantExpiresAt === undefined ? {} : { grantExpiresAt: admitted.grantExpiresAt }),
    };
  }
  /** The confirmation, as the channel's first message; the device's effects run only then. */
  async function confirmation(
    channel: HostChannel,
    session: NkSession,
    deviceId: DeviceId,
    held: Credential,
  ): Promise<HelloConfirm | undefined> {
    try {
      const raw = await channel.receiveRaw();
      if (session.closed || typeof raw !== "string") throw new Error("No confirmation");
      const confirm = HelloConfirm.parse(JSON.parse(raw));
      // A link proof and a machine code go with a grant only, as in a hello.
      if (held.paired && (confirm.link !== undefined || confirm.machineCode !== undefined))
        throw new Error("Invalid confirmation");
      session.confirm();
      channel.authorize();
      if (held.paired) {
        options.auth.touch(held.paired);
        options.auth.recognize(held.paired, confirm.installId);
      } else options.auth.accountDeviceSeen(deviceId, confirm.link);
      return confirm;
    } catch {
      session.close();
      channel.close();
      return undefined;
    }
  }
  return {
    arrive: () => admission.arrive(),
    refusalDelay: (arrivedAt) => admission.refusalDelay(arrivedAt),
    async admit(payload, ephemeral): Promise<NkAccepted | undefined> {
      const early = parseEarly(payload);
      if (!early || !admission.claim(early.deviceId)) return undefined;
      const claim = admission.suppress(ephemeral);
      if (typeof claim === "string") return undefined;
      const held = await credential(early).catch(() => undefined);
      let channel: HostChannel | undefined;
      const session = held ? admission.admit(early.deviceId, () => channel?.close()) : undefined;
      if (!held || !session) {
        claim.release();
        return undefined;
      }
      return {
        abandon: () => session.close(),
        async open(opened) {
          channel = opened;
          void opened.closed.then(() => session.close());
          const confirmed = confirmation(opened, session, early.deviceId, held);
          await options.serve({
            channel: opened,
            early,
            actor: held.actor,
            session,
            stillAdmitted: held.stillAdmitted,
            account: held.account,
            grantExpiresAt: held.grantExpiresAt,
            confirmed,
          });
        },
      };
    },
  };
}
