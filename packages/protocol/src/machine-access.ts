import { z } from "zod";
import { AceAccount, AceAccountGrant, AceAccountOrigin } from "./ace-account.ts";

/**
 * A machine code (ADR 0111): an optional PIN or password a device on the daemon's ace account
 * enters once before its grant opens this machine. Only the daemon ever checks it.
 */
export const MachineCode = z.string().min(4).max(128);

/**
 * Why a daemon refused an account device's hello, sent as the `error` frame's `code` before the
 * channel closes. The client asks for the code and opens a new channel with `machineCode`.
 */
export const MachineCodeRefusal = z.enum([
  /** This machine has a code and this device has not entered the current one. */
  "machine_code_required",
  /** The code in the hello was wrong. */
  "machine_code_wrong",
  /** Too many wrong codes: code entry on this machine is paused for a while. */
  "machine_code_locked",
]);
export type MachineCodeRefusal = z.infer<typeof MachineCodeRefusal>;

/** `PUT /v1/machine-code` on the daemon: set or replace this machine's code (admin only). */
export const MachineCodeChange = z.object({ code: MachineCode });

/** `PUT /v1/ace-account`: hand this daemon an ace session (the desktop app's own, or `ace login`'s). */
export const AceAccountHandover = z.object({
  origin: AceAccountOrigin,
  token: AceAccountGrant.shape.token,
});

/** `POST /v1/ace-account/login`: start ace sign-in from this machine (`ace login`). */
export const AceAccountLoginStart = z.object({ origin: AceAccountOrigin.optional() });

/** The daemon's ace account, its pending sign-in and its machine code, for status and the CLI. */
export const MachineAccountStatus = z.object({
  /** Signed in with a session that has not expired. */
  signedIn: z.boolean(),
  origin: z.string().max(2048).optional(),
  account: AceAccount.optional(),
  expiresAt: z.number().int().positive().optional(),
  /** A sign-in started on this machine that has not finished yet. */
  login: z.object({ url: z.url(), expiresAt: z.number().int().positive() }).optional(),
  machineCode: z.object({
    set: z.boolean(),
    /** Code entry is paused until then after too many wrong codes. */
    lockedUntil: z.number().int().positive().optional(),
  }),
});
export type MachineAccountStatus = z.infer<typeof MachineAccountStatus>;
