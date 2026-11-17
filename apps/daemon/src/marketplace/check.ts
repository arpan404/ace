import {
  contentHash,
  frontmatter,
  hashFiles,
  pluginManifests,
  privacySpans,
  privacyWords,
  secretValueProblems,
  sha256Hex,
  writeArchive,
  type ArchiveFile,
} from "@ace/marketplace";
import { hiddenFileFindings } from "@ace/marketplace/scan";
import type {
  MarketDraftCheck,
  MarketDraftChecked,
  MarketDraftFinding,
  MarketMe,
  MarketPickType,
  MarketPublishAction,
  Recipe,
} from "@ace/protocol/marketplace";
import { z } from "zod";
import { entryNameOf, readPicked, type Picked, type PickPorts } from "./pick.ts";
import { Refused } from "./prepare.ts";

/*
 * What a draft would upload, checked on this machine before anything leaves it (ADR 0174 §2).
 * `checkDraft` reads the picked thing and answers its exact files (binaries apart, uploaded
 * only when ticked), what was left home, and what the secrets, hidden-text and privacy checks
 * found, with a hash of what it read. `confirmedArchive` reads it again for the draft: the hash
 * must match, nothing may block, every flagged text must be one the person confirmed, and a
 * bot's task and routines are the person's edited ones, checked again here. Pure apart from
 * the ports' reads.
 */

type DraftSource = Extract<MarketPublishAction, { action: "draftCreate" }>["source"];

export interface CheckInput {
  type: MarketPickType;
  name: string;
  source: DraftSource;
  /** The publisher's own page, asked for only when a manifest names an author. */
  me: () => Promise<MarketMe>;
}

interface Examined {
  check: MarketDraftCheck;
  files: ArchiveFile[];
  recipe: Recipe | undefined;
}

const encoder = new TextEncoder();
const digest = (value: unknown) => sha256Hex(encoder.encode(JSON.stringify(value)));

/** A file is text when it decodes as UTF-8 and holds no NUL byte. */
function textOf(content: Uint8Array): string | undefined {
  if (content.includes(0)) return undefined;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(content);
  } catch {
    return undefined;
  }
}

const quoted = (text: string) => `"${text.length > 80 ? `${text.slice(0, 77)}…` : text}"`;

function fileFindings(file: ArchiveFile, names: readonly string[]): MarketDraftFinding[] {
  const text = textOf(file.content);
  if (text === undefined) return [];
  const found: MarketDraftFinding[] = [];
  for (const problem of secretValueProblems(text, file.path))
    found.push({
      path: file.path,
      ...(problem.line ? { line: problem.line } : {}),
      kind: "secret",
      text: "",
      sentence: `${file.path}: ${problem.message}. Take it out before publishing.`,
      blocking: true,
    });
  for (const hidden of hiddenFileFindings(file.path, text))
    if (hidden.level === "block")
      found.push({
        path: file.path,
        ...(hidden.line ? { line: hidden.line } : {}),
        kind: "hidden-text",
        text: "",
        sentence: hidden.message,
        blocking: true,
      });
  for (const [index, line] of text.split("\n").entries())
    for (const span of privacySpans(line, { names }))
      if (span.kind !== "secret")
        found.push({
          path: file.path,
          line: index + 1,
          kind: span.kind,
          text: span.text,
          sentence: `${quoted(span.text)} ${privacyWords[span.kind]}.`,
          blocking: false,
        });
  return found;
}

const Author = z.union([
  z.string(),
  z.object({ name: z.string() }).transform((author) => author.name),
]);
const Manifest = z.looseObject({
  name: z.string().optional().catch(undefined),
  author: Author.optional().catch(undefined),
  /** Agent Skills keep extra fields under `metadata`. */
  metadata: z
    .looseObject({ author: Author.optional().catch(undefined) })
    .optional()
    .catch(undefined),
});

/** The name and author a skill's SKILL.md or a plugin's manifest gives, and where. */
function identityOf(type: MarketPickType, files: readonly ArchiveFile[]) {
  const byPath = new Map(files.map((file) => [file.path, file] as const));
  if (type === "spade-plugin") {
    const path = pluginManifests.find((candidate) => byPath.has(candidate));
    if (!path) return { path: "plugin.json", name: undefined, author: undefined };
    let json: unknown;
    try {
      json = JSON.parse(textOf(byPath.get(path)?.content ?? new Uint8Array()) ?? "");
    } catch {
      json = undefined;
    }
    const read = Manifest.safeParse(json);
    return { path, name: read.data?.name, author: read.data?.author };
  }
  const data = frontmatter(textOf(byPath.get("SKILL.md")?.content ?? new Uint8Array()) ?? "").data;
  const read = Manifest.safeParse(data);
  return {
    path: "SKILL.md",
    name: read.data?.name,
    author: read.data?.author ?? read.data?.metadata?.author,
  };
}

/** The manifest still names what was picked, and no other author than the publisher. */
async function checkIdentity(input: CheckInput, picked: Extract<Picked, { kind: "files" }>) {
  const identity = identityOf(input.type, picked.files);
  if (picked.picked !== undefined) {
    if (!identity.name)
      throw new Refused(
        `${identity.path} doesn't name ${picked.picked}, so it isn't what you picked`,
      );
    if (entryNameOf(identity.name, "") !== entryNameOf(picked.picked, ""))
      throw new Refused(
        `${identity.path} names it ${identity.name}, not ${picked.picked}, so it isn't what you picked`,
      );
  }
  if (identity.author === undefined) return;
  const profile = (await input.me()).profile;
  if (!profile) throw new Refused("Make your publisher profile first");
  const yours = [profile.handle, profile.displayName].map((each) => each.trim().toLowerCase());
  if (!yours.includes(identity.author.trim().toLowerCase()))
    throw new Refused(
      `${identity.path} names ${identity.author} as its author, not you, so it isn't yours to publish`,
    );
}

async function examine(ports: PickPorts, input: CheckInput): Promise<Examined | undefined> {
  const picked = await readPicked(ports, input.type, input.source);
  if (!picked) return undefined;
  const names = await ports.names();
  const spans = (text: string) => privacySpans(text, { names });
  if (picked.kind === "bot") {
    const { recipe } = picked;
    return {
      check: {
        files: [],
        excluded: [],
        findings: [],
        hash: digest({ type: input.type, name: input.name, recipe }),
        bot: {
          recipe,
          leftOut: picked.leftOut,
          name: spans(recipe.name),
          task: spans(recipe.task),
          routines: recipe.routines.map((routine) => ({
            name: spans(routine.name),
            instruction: spans(routine.instruction),
          })),
        },
      },
      files: [],
      recipe,
    };
  }
  await checkIdentity(input, picked);
  const files = picked.files.toSorted((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return {
    check: {
      files: files.map((file) => ({
        path: file.path,
        bytes: file.content.byteLength,
        binary: textOf(file.content) === undefined,
      })),
      excluded: picked.excluded.toSorted((a, b) => (a.path < b.path ? -1 : 1)),
      findings: files.flatMap((file) => fileFindings(file, names)).slice(0, 500),
      hash: digest({ type: input.type, name: input.name, files: contentHash(hashFiles(files)) }),
    },
    files,
    recipe: undefined,
  };
}

/** What a draft from `input.source` would upload; undefined for a Suit or an archive. */
export async function checkDraft(
  ports: PickPorts,
  input: CheckInput,
): Promise<MarketDraftCheck | undefined> {
  return (await examine(ports, input))?.check;
}

/** Every flagged text in `texts` must be confirmed; a secret never can be. */
function confirmTexts(
  texts: readonly { what: string; text: string }[],
  names: readonly string[],
  accepted: ReadonlySet<string>,
) {
  for (const { what, text } of texts)
    for (const span of privacySpans(text, { names })) {
      if (span.kind === "secret")
        throw new Refused(
          `${what} holds what ${privacyWords.secret}; take it out before publishing`,
        );
      if (!accepted.has(span.text))
        throw new Refused(
          `${quoted(span.text)} in ${what} ${privacyWords[span.kind]}; confirm it or take it out`,
        );
    }
}

/**
 * The archive a draft from `input.source` uploads, once the person confirmed its check; undefined
 * for a Suit or an archive, whose bytes are read as before.
 */
export async function confirmedArchive(
  ports: PickPorts,
  input: CheckInput & { checked: MarketDraftChecked | undefined },
): Promise<Uint8Array | undefined> {
  const examined = await examine(ports, input);
  if (!examined) return undefined;
  const { checked } = input;
  if (!checked) throw new Refused("Check what will upload and confirm it before publishing");
  if (checked.hash !== examined.check.hash)
    throw new Refused("It changed since you checked it; check it again before publishing");
  const accepted = new Set(checked.accepted);
  const names = await ports.names();
  if (examined.recipe) {
    const exported = examined.recipe;
    if (!checked.recipe) throw new Refused("Confirm the task, and choose its routines, first");
    for (const routine of checked.recipe.routines)
      if (
        !exported.routines.some(
          (each) => each.name === routine.name && each.schedule === routine.schedule,
        )
      )
        throw new Refused(`The routine ${routine.name} isn't one of this bot's`);
    const recipe: Recipe = {
      ...exported,
      task: checked.recipe.task,
      routines: checked.recipe.routines,
    };
    confirmTexts(
      [
        { what: "The name", text: recipe.name },
        { what: "The task", text: recipe.task },
        ...recipe.routines.flatMap((routine) => [
          { what: `The routine ${routine.name}`, text: routine.name },
          { what: `The routine ${routine.name}`, text: routine.instruction },
        ]),
        ...[...recipe.skills, ...recipe.plugins].map((text) => ({
          what: "Its skills and plugins",
          text,
        })),
      ],
      names,
      accepted,
    );
    const text = `${JSON.stringify(recipe, null, 2)}\n`;
    return writeArchive([{ path: "bot.json", executable: false, content: encoder.encode(text) }]);
  }
  const blocking = examined.check.findings.find((finding) => finding.blocking);
  if (blocking) throw new Refused(blocking.sentence);
  for (const finding of examined.check.findings)
    if (!accepted.has(finding.text))
      throw new Refused(
        `${quoted(finding.text)} in ${finding.path} ${finding.kind === "hidden-text" ? "is hidden text" : privacyWords[finding.kind]}; confirm it or take it out`,
      );
  const ticked = new Set(checked.binaries);
  const binary = new Set(
    examined.check.files.filter((file) => file.binary).map((file) => file.path),
  );
  return writeArchive(
    examined.files.filter((file) => !binary.has(file.path) || ticked.has(file.path)),
  );
}
