/*
 * The desktop app's device key (ADR 0190, amendment 1), which only its main process holds and
 * uses. A window asks it to prove the app's own sockets, or, right after a browser sign-in, to
 * enroll the key; it never hands main a challenge, a socket or an account. Absent in a browser,
 * which proves with its session's grant on every socket.
 */

export interface AppStandingKey {
  /** "Prove me": true when main proved the app's own sockets with the device key. */
  prove(origin: string): Promise<boolean>;
  /** "Enroll": true when main enrolled the device key after a browser sign-in, and proved. */
  enroll(origin: string): Promise<boolean>;
}

export function appStandingKey(scope: object = globalThis): AppStandingKey | undefined {
  const ace: unknown = Reflect.get(scope, "ace");
  if (!ace || typeof ace !== "object") return undefined;
  const standing: unknown = Reflect.get(ace, "standing");
  if (!standing || typeof standing !== "object") return undefined;
  const prove: unknown = Reflect.get(standing, "prove");
  const enroll: unknown = Reflect.get(standing, "enroll");
  if (typeof prove !== "function" || typeof enroll !== "function") return undefined;
  return {
    prove: async (origin) => (await prove(origin)) === true,
    enroll: async (origin) => (await enroll(origin)) === true,
  };
}
