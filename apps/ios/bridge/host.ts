import { connectHost, hostScheduler, requester, type NativeHost } from "@ace/native-host";

/*
 * The phone's native host (`@ace/native-host`, ADR 0096): Swift installs it as `aceHost` before
 * this bundle runs, and every callback stays on the script's run loop. This module is the
 * bridge's only way to the platform.
 */
declare global {
  var aceHost: NativeHost;
}
export const host = connectHost(globalThis.aceHost);
/** Typed async platform operations; failures reject with `HostCallError`. */
export const call = requester(host);
export const scheduler = hostScheduler(host);
