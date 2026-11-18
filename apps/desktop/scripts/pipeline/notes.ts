#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { parseBetaTag } from "@ace/service/release-line";
import { notesProblems, type NotesRules } from "../../src/packaging/release-notes-check.ts";
import {
  agentEnvironment,
  NotesConfig,
  notesAgentCommand,
  notesFromReply,
  notesPrompt,
  previousReleaseTag,
  prNumbersFromLog,
  PullRequest,
} from "../../src/packaging/release-notes-input.ts";
import { repo } from "../common.ts";
import { gh, releaseState, run, say, step, summary, tagArgument, tagCommit } from "./github.ts";

/**
 * Writes the release's notes with an agent and puts them on the draft (ADR 0188), on omarchy:
 *
 *   node apps/desktop/scripts/pipeline/notes.ts <tag> <title>
 *
 * Gathers the PRs merged since the previous published release, asks the agent configured in
 * `release/notes.json` for notes (read-only, through this machine's own logged-in CLI), checks
 * them, and retries once with the problems found. Notes already on the draft that pass the same
 * checks are kept, so a rerun doesn't write them again. Fails when the second try fails too.
 */
const agentTimeoutMs = 15 * 60 * 1000;

step(async () => {
  const tag = tagArgument();
  const title = process.argv[3] ?? tag;
  const config = NotesConfig.parse(
    JSON.parse(readFileSync(join(repo, "release/notes.json"), "utf8")),
  );
  const published = z
    .array(z.object({ tagName: z.string() }))
    .parse(
      JSON.parse(
        gh(["release", "list", "--exclude-drafts", "--limit", "500", "--json", "tagName"]),
      ),
    )
    .map((release) => release.tagName);
  const base = previousReleaseTag(published, tag);
  const head = tagCommit(tag);
  const range = base ? `${base}..${head}` : head;
  const subjects = run("git", ["log", "--first-parent", "--format=%s", range]).split("\n");
  const prs = prNumbersFromLog(subjects).map((number) =>
    PullRequest.parse(
      JSON.parse(gh(["pr", "view", String(number), "--json", "number,title,body,labels"])),
    ),
  );
  say(`${prs.length} PRs since ${base ?? "the first commit"}`);
  const rules: NotesRules = {
    kind: parseBetaTag(tag) ? "beta" : "stable",
    prs: new Set(prs.map((pr) => pr.number)),
    limits: config.limits,
    bannedTerms: config.bannedTerms,
  };

  const state = releaseState(tag);
  if (!state.exists) throw new Error(`${tag} has no release; run prepare first`);
  if (state.body.trim() && notesProblems(state.body, rules).length === 0) {
    say("the release already has notes that pass every check; keeping them");
    return;
  }

  const template = readFileSync(join(repo, config.template), "utf8");
  const { command, args } = notesAgentCommand(config);
  let problems: string[] = [];
  for (const tryNumber of [1, 2]) {
    const prompt = notesPrompt({
      template,
      title,
      kind: rules.kind,
      prs,
      limits: config.limits,
      problems,
    });
    say(`asking ${config.provider} (${config.model}, ${config.effort} effort), try ${tryNumber}`);
    const reply = spawnSync(command, args, {
      cwd: await mkdtemp(join(process.env.RUNNER_TEMP ?? tmpdir(), "ace-notes-")),
      env: agentEnvironment(process.env),
      input: prompt,
      encoding: "utf8",
      timeout: agentTimeoutMs,
      maxBuffer: 16 * 1024 * 1024,
    });
    if (reply.status !== 0) {
      problems = [
        `The agent exited with ${reply.status ?? reply.signal}: ${(reply.stderr ?? "").slice(-2000)}`,
      ];
      say(problems[0] ?? "");
      continue;
    }
    const notes = notesFromReply(reply.stdout);
    problems = notesProblems(notes, rules);
    if (problems.length === 0) {
      const file = join(
        await mkdtemp(join(process.env.RUNNER_TEMP ?? tmpdir(), "ace-notes-")),
        "notes.md",
      );
      await writeFile(file, notes);
      gh(["release", "edit", tag, "--notes-file", file]);
      summary(`### Release notes\n\n${notes}`);
      say("notes written to the draft");
      return;
    }
    say(`try ${tryNumber} was rejected:\n${problems.join("\n")}`);
  }
  throw new Error(`The release notes failed their checks twice:\n${problems.join("\n")}`);
});
