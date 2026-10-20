/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_ACE_DAEMON_URL?: string;
  /** Set by the build (`vite.config.ts`): which build this page is. */
  readonly VITE_ACE_BUILD?: string;
}
