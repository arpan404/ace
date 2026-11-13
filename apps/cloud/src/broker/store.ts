import type { CallbackVerdict, FinishVerdict, SignIn } from "./sign-ins.ts";

/**
 * Where sign-ins in progress live: one account's in its Durable Object in the Worker, a map in
 * unit tests. Every call takes the caller's clock, so expiry is the caller's decision.
 */
export interface SignInStore {
  begin(signIn: SignIn, now: number): Promise<void>;
  appOf(state: string): Promise<string | undefined>;
  callback(
    input: {
      state: string;
      app: string;
      code: string | undefined;
      declined: boolean;
      issuerOk: boolean;
    },
    now: number,
  ): Promise<CallbackVerdict>;
  finish(
    input: { handle: string; account: string; app: string; verifier: string },
    now: number,
  ): Promise<FinishVerdict>;
}

export interface SignInDirectory {
  /** `account`'s store, and the routing prefix its sign-ins' OAuth `state` starts with. */
  forAccount(account: string): { store: SignInStore; route: string };
  /** The store a callback's `state` routes to, if it names one. */
  forState(state: string): SignInStore | undefined;
}

/** A state is `<route>.<random>`: the route finds the account's store without naming it. */
export function stateRoute(state: string): string | undefined {
  return /^([0-9a-f]{64})\.[A-Za-z0-9_-]{43}$/.exec(state)?.[1];
}
