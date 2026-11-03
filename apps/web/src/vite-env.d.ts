/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_ACE_ACCOUNT_URL?: string;
  /** ace's hosted relay (`wss://`); the account origin as `wss://` when unset. */
  readonly VITE_ACE_HOSTED_RELAY_URL?: string;
  readonly VITE_ACE_DAEMON_URL?: string;
  /** Set by the build (`vite.config.ts`): which build this page is. */
  readonly VITE_ACE_BUILD?: string;
}
