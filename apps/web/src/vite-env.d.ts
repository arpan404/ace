/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_ACE_ACCOUNT_URL?: string;
  /** ace's hosted relay (`wss://`); the account origin as `wss://` when unset. */
  readonly VITE_ACE_HOSTED_RELAY_URL?: string;
  readonly VITE_ACE_DAEMON_URL?: string;
  /** Set by the build (`vite.config.ts`): which build this page is. */
  readonly VITE_ACE_BUILD?: string;
  /** Set by the build from `ACE_FAKE_PR_PUSH_EVERY_MS`: the fake app's sample push timer. */
  readonly VITE_ACE_FAKE_PR_PUSH_EVERY_MS?: string;
  /** Set by the build: `off` when built with `DISABLE_SPADE=1`, so Spade's screens are left out. */
  readonly VITE_ACE_SPADE?: string;
}
