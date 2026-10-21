import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { nodeVersion } from "@ace/release/node-runtime";
import { releaseRepository, releaseTag } from "../src/packaging/release-plan.ts";
import { developerIdIdentities, notaryCredentials } from "../src/packaging/release-signing.ts";
import { repo } from "./common.ts";

/** The command-line tools a release uses, and what this Mac has set up for them. */

export function capture(command: string, args: string[]): { ok: boolean; out: string } {
  const result = spawnSync(command, args, { cwd: repo, encoding: "utf8" });
  return { ok: result.status === 0, out: `${result.stdout ?? ""}${result.stderr ?? ""}`.trim() };
}

export function sha256(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    createReadStream(path)
      .on("data", (chunk) => hash.update(chunk))
      .on("error", reject)
      .on("end", () => resolve(hash.digest("hex")));
  });
}

export function headCommit(): string {
  return capture("git", ["rev-parse", "HEAD"]).out;
}

/** No tracked file differs from the commit; untracked notes and scratch files don't count. */
export function worktreeClean(): boolean {
  const status = capture("git", ["status", "--porcelain", "--untracked-files=no"]);
  return status.ok && status.out === "";
}

/** Whether GitHub has the commit, so a release tag can point at it. */
export function pushed(commit: string): boolean {
  capture("git", ["fetch", "--quiet", "origin"]);
  const branches = capture("git", ["branch", "-r", "--contains", commit]);
  return branches.ok && branches.out !== "";
}

export function githubReady(): boolean {
  return capture("gh", ["auth", "status"]).ok;
}

export function releaseExists(version: string): boolean {
  return capture("gh", ["release", "view", releaseTag(version), "--repo", releaseRepository]).ok;
}

/** The Developer ID the build will sign with: CSC_NAME when set, else the keychain's only one. */
export type SigningIdentity = { ok: true; name: string } | { ok: false; problem: string };

export function signingIdentity(env: NodeJS.ProcessEnv): SigningIdentity {
  const identities = developerIdIdentities(
    capture("security", ["find-identity", "-v", "-p", "codesigning"]).out,
  );
  if (identities.length === 0)
    return {
      ok: false,
      problem:
        'No "Developer ID Application" certificate in the keychain (Apple Development and Apple Distribution certificates cannot sign apps for notarized distribution)',
    };
  const wanted = env.CSC_NAME;
  if (wanted) {
    const match = identities.find((name) => name.includes(wanted));
    return match
      ? { ok: true, name: match }
      : { ok: false, problem: `CSC_NAME "${wanted}" matches no Developer ID` };
  }
  if (identities.length > 1)
    return {
      ok: false,
      problem: `Several Developer IDs; set CSC_NAME to one of: ${identities.join(", ")}`,
    };
  return { ok: true, name: identities[0] ?? "" };
}

export interface Check {
  name: string;
  ok: boolean;
  detail: string;
  /** Needed for: a signed release, publishing, or `--with-daemon`. */
  for: "signed" | "publish" | "daemon" | "any";
}

/** Everything `release:doctor` reports, without changing anything. */
export function releaseChecks(env: NodeJS.ProcessEnv): Check[] {
  const checks: Check[] = [];
  const add = (check: Check) => checks.push(check);
  add({
    name: "macOS",
    ok: process.platform === "darwin",
    detail: `${process.platform}-${process.arch}; releases build for this machine's architecture`,
    for: "any",
  });
  const notarytool = capture("xcrun", ["--find", "notarytool"]).ok;
  const stapler = capture("xcrun", ["--find", "stapler"]).ok;
  add({
    name: "Xcode command line tools",
    ok: notarytool && stapler,
    detail: notarytool && stapler ? "notarytool and stapler found" : "run xcode-select --install",
    for: "signed",
  });
  const identity = signingIdentity(env);
  add({
    name: "Developer ID",
    ok: identity.ok,
    detail: identity.ok ? identity.name : identity.problem,
    for: "signed",
  });
  const notary = notaryCredentials(env);
  add({
    name: "Notarization credentials",
    ok: notary.kind !== "none" && notary.kind !== "incomplete",
    detail:
      notary.kind === "none"
        ? "set APPLE_KEYCHAIN_PROFILE (xcrun notarytool store-credentials), APPLE_API_KEY/_ID/ISSUER, or APPLE_ID/APPLE_APP_SPECIFIC_PASSWORD/APPLE_TEAM_ID"
        : notary.kind === "incomplete"
          ? `missing ${notary.missing.join(", ")}`
          : notary.kind,
    for: "signed",
  });
  const gh = capture("gh", ["--version"]).ok;
  add({
    name: "GitHub CLI",
    ok: gh && githubReady(),
    detail: !gh
      ? "install with brew install gh"
      : githubReady()
        ? "signed in"
        : "run gh auth login",
    for: "publish",
  });
  const commit = headCommit();
  const clean = worktreeClean();
  add({
    name: "Clean checkout on GitHub",
    ok: clean && pushed(commit),
    detail: !clean
      ? "commit or stash your changes"
      : pushed(commit)
        ? commit.slice(0, 12)
        : `push ${commit.slice(0, 12)} first`,
    for: "publish",
  });
  const publicKey = env.ACE_RELEASE_PUBLIC_KEY_FILE;
  const privateKey = env.ACE_RELEASE_PRIVATE_KEY_FILE;
  add({
    name: "Daemon release keys",
    ok: Boolean(publicKey && privateKey && existsSync(publicKey) && existsSync(privateKey)),
    detail:
      "ACE_RELEASE_PUBLIC_KEY_FILE and ACE_RELEASE_PRIVATE_KEY_FILE (tools/release/README.md)",
    for: "daemon",
  });
  add({
    name: `Node ${nodeVersion}`,
    ok: process.versions.node === nodeVersion,
    detail: `running ${process.versions.node}; daemon archives build only on the pinned Node`,
    for: "daemon",
  });
  return checks;
}
