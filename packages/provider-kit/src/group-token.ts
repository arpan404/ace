import { randomUUID } from "node:crypto";

/*
 * Each POSIX spawn's environment carries a fresh random token, inherited by everything it starts
 * unless that process deliberately starts with a clean environment. After the leader is reaped,
 * a process found in its old group counts as the group's on Linux only if its start environment
 * carries the token (`leader-group.ts`): an unrelated group that later took the same id cannot.
 */
export const GROUP_TOKEN_ENV = "ACE_PROCESS_GROUP";

/** A fresh token for one spawn. */
export function newGroupToken(): string {
  return randomUUID();
}

/** `env` with the group token added. */
export function withGroupToken(env: NodeJS.ProcessEnv, token: string): NodeJS.ProcessEnv {
  return { ...env, [GROUP_TOKEN_ENV]: token };
}

/** Whether a start environment carries exactly this token. */
export function carriesGroupToken(environment: readonly string[], token: string): boolean {
  return environment.includes(`${GROUP_TOKEN_ENV}=${token}`);
}
