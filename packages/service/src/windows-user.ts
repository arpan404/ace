import { checked, runProcess } from "./process.ts";

/** The signed-in account's SID; `whoami /user` prints it as the second CSV field. */
export async function currentUserSid(): Promise<string> {
  const { stdout } = await checked(runProcess, "whoami.exe", ["/user", "/fo", "csv", "/nh"]);
  return sidFromWhoami(stdout);
}

/** The SID in `whoami /user /fo csv /nh` output: its second CSV field. */
export function sidFromWhoami(stdout: string): string {
  const sid = /"(S-1-[\d-]+)"\s*$/.exec(stdout.trim())?.[1];
  if (!sid) throw new Error("Cannot read the current user's SID");
  return sid;
}
