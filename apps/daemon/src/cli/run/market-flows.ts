import { readFile } from "node:fs/promises";
import { describeListing } from "@ace/mcp-server/market-verbs";
import type {
  MarketDraft,
  MarketDraftCheck,
  MarketReview,
  MarketReviewItem,
} from "@ace/protocol/marketplace";
import { timeoutMs } from "../args.ts";
import { emit } from "../io.ts";
import { marketAction } from "../market/actions.ts";
import { installReviewed, reviewText, type Consent, type Installed } from "../market/install.ts";
import { printed, readText } from "../market/output.ts";
import {
  createDraft,
  publishDraft as publishOne,
  publishQuestion,
  waitForVersion,
  type PublishConsent,
} from "../market/publish.ts";
import { parseEntry } from "../market/refs.ts";
import { answerOf, withMarket } from "../market/request.ts";
import { CliFailure } from "../output.ts";
import { publishLines } from "../render/market.ts";
import { installQuestion } from "../render/market-review.ts";
import { ownThread, type CommandContext } from "./context.ts";

/* The market commands that take more than one request, or ask the person (ADR 0176 §11, §12). */

const stderr = (text: string) => void process.stderr.write(text);
const flag = (context: CommandContext, name: string) => {
  const value = context.args.flags[name];
  return typeof value === "string" ? value : undefined;
};

/** Signed out or a stale sign-in, on a terminal: offer to sign in, then run it once more. */
async function signedIn<T>(context: CommandContext, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    const code = error instanceof CliFailure ? error.detail.code : undefined;
    if (!context.args.interactive || (code !== "signed_out" && code !== "reauth")) throw error;
    const { askConfirm } = await import("../ask.ts");
    const asked =
      code === "reauth"
        ? "Sign in again to do this. Sign in now?"
        : "Sign in to publish. Sign in now?";
    if (!(await askConfirm(asked, true))) throw error;
    const { aceAccountCommand } = await import("../ace-account.ts");
    await aceAccountCommand(
      { ...context.args, words: [], flags: {} },
      (await context.config()).dataDir,
      "login",
    );
    return run();
  }
}

/** One request, printed as its answer. */
export async function one(context: CommandContext): Promise<void> {
  const { words, flags, lists } = context.args;
  // Usage errors come before any connection.
  const operation = marketAction(context.command.id, { words, flags, lists });
  const answer = await signedIn(context, () => withMarket(context, (ask) => ask(operation)));
  const out = printed(answer);
  return emit(context.args, out.value, out.render);
}

/** Texts given as `-` or `@FILE` read first, then one request. */
export async function withTexts(context: CommandContext, fields: readonly string[]): Promise<void> {
  const words = [...context.args.words];
  const flags = { ...context.args.flags };
  for (const field of fields) {
    if (field === "TEXT") {
      const text = await readText(words[1]);
      if (text !== undefined) words[1] = text;
    } else {
      const text = await readText(flag(context, field));
      if (text !== undefined) flags[field] = text;
    }
  }
  return one({ ...context, args: { ...context.args, words, flags } });
}

/* ---------------------------------------------------------------- install and update */

/** Who answers a review: a person here, `--yes`, the daemon's gate for an agent, or nobody. */
function installConsent(context: CommandContext): Consent {
  if (ownThread(context)) return { kind: "agent" };
  if (context.args.flags.yes === true) return { kind: "yes" };
  if (!context.args.interactive) return { kind: "none" };
  return {
    kind: "terminal",
    confirm: async (review: MarketReview, items: readonly MarketReviewItem[]) => {
      const { askConfirm, askSelect } = await import("../ask.ts");
      process.stdout.write(reviewText(review, items));
      for (;;) {
        const choice = await askSelect(installQuestion(review, items), [
          { value: "install", label: review.updates ? "Update" : "Install" },
          { value: "cancel", label: "Cancel" },
          { value: "files", label: "Read the files" },
        ]);
        if (choice === "cancel")
          throw new CliFailure("failed", "Cancelled. Nothing was installed.");
        if (choice === "files") {
          for (const item of items)
            if (item.kind === "file")
              process.stdout.write(
                `  ${item.file.path}  ${item.file.bytes} bytes${item.file.flagged ? ", a script or binary" : ""}\n`,
              );
            else if (item.kind === "text") process.stdout.write(`--- ${item.path}\n${item.text}\n`);
          continue;
        }
        const routines = review.body.type === "spade-bot" && review.body.routines.length > 0;
        return {
          startRoutines: routines ? await askConfirm("Start its routines now?", false) : false,
        };
      }
    },
  };
}

const installedLine = (done: Installed) =>
  `${done.review.updates ? "Updated" : "Installed"} ${done.review.type}/${done.review.name} ${done.review.version}.`;

export async function install(context: CommandContext): Promise<void> {
  const ref = parseEntry(context.args.words[0]);
  const version = flag(context, "version") ?? ref.version;
  const done = await withMarket(context, (ask) =>
    installReviewed(
      ask,
      {
        op: "prepare",
        source: flag(context, "source") ?? "market",
        type: ref.type,
        name: ref.name,
        ...(version ? { version } : {}),
      },
      installConsent(context),
      stderr,
    ),
  );
  return emit(context.args, done, { human: () => [installedLine(done)], quiet: () => [] });
}

export async function update(context: CommandContext): Promise<void> {
  const named = context.args.words.map((word) => parseEntry(word));
  if (named.length === 0 && context.args.flags.all !== true)
    throw new CliFailure("usage", "Name what to update, or pass --all.", undefined, {
      code: "missing_argument",
      argument: "REF",
      hint: "See what has updates with ace market installed --updates.",
    });
  const consent = installConsent(context);
  const updated = await withMarket(context, async (ask) => {
    const targets = named.length
      ? named
      : answerOf(await ask({ op: "installed" }), "installed").installed.filter(
          (entry) => entry.update,
        );
    const done: Installed[] = [];
    for (const target of targets)
      done.push(
        await installReviewed(
          ask,
          { op: "prepareUpdate", type: target.type, name: target.name },
          consent,
          stderr,
        ),
      );
    return done;
  });
  return emit(
    context.args,
    { updated },
    {
      human: () => (updated.length ? updated.map(installedLine) : ["Everything is up to date."]),
      quiet: () => [],
    },
  );
}

/* ---------------------------------------------------------------- publishing */

function publishConsent(context: CommandContext, unlisted: boolean): PublishConsent {
  const yes = context.args.flags.yes === true;
  if (!context.args.interactive || yes)
    return {
      findings: async () => yes,
      publish: async (draft: MarketDraft) => {
        if (yes) return true;
        throw new CliFailure(
          "needs-human",
          `Draft ${draft.id} is ready; publishing it needs your yes.`,
          { kind: "draft", draft },
          { code: "confirm", hint: `Publish it with ace market draft publish ${draft.id} --yes.` },
        );
      },
    };
  return {
    findings: async (check: MarketDraftCheck) => {
      const { askConfirm } = await import("../ask.ts");
      for (const finding of check.findings) process.stdout.write(`  ${finding.sentence}\n`);
      for (const file of check.files.filter((each) => each.binary))
        process.stdout.write(`  ${file.path} is a binary file.\n`);
      return askConfirm("Publish these as they are?", false);
    },
    publish: async (draft: MarketDraft) => {
      const { askConfirm } = await import("../ask.ts");
      process.stdout.write(`${publishLines({ kind: "draft", draft }).slice(0, -1).join("\n")}\n`);
      return askConfirm(publishQuestion(draft, unlisted), true);
    },
  };
}

/** After a publish: `--wait` watches it settle; the answer prints either way. */
async function published(
  context: CommandContext,
  ask: Parameters<Parameters<typeof withMarket>[1]>[0],
  draft: MarketDraft,
  unlisted: boolean,
) {
  const answer = await publishOne(ask, draft, publishConsent(context, unlisted), unlisted);
  if (!answer) return { kind: "kept" as const, draft };
  if (context.args.flags.wait !== true) return { kind: "published" as const, answer };
  const status = await waitForVersion(ask, draft, {
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now: () => Date.now(),
    deadline: Date.now() + timeoutMs(context.args) - 10_000,
  });
  return { kind: "published" as const, answer, status };
}

async function finish(
  context: CommandContext,
  outcome: Awaited<ReturnType<typeof published>>,
): Promise<void> {
  if (outcome.kind === "kept") {
    const { draft } = outcome;
    return emit(
      context.args,
      { kind: "draft", draft },
      { human: () => [`Kept as draft ${draft.id}.`], quiet: () => [draft.id] },
    );
  }
  await emit(context.args, outcome.answer, { human: () => publishLines(outcome.answer) });
  if (!("status" in outcome)) return;
  if (outcome.status === "blocked")
    throw new CliFailure("failed", "ace's signer blocked it.", undefined, {
      code: "blocked",
      hint: "See why with ace market versions, and ask for a look with ace market appeal.",
    });
  if (outcome.status === "waiting")
    throw new CliFailure("timeout", "It still waits for ace's signer.", undefined, {
      code: "timeout",
      hint: "See where it is with ace market status.",
    });
}

export async function publish(context: CommandContext): Promise<void> {
  const [type = "", target = ""] = context.args.words;
  const unlisted = context.args.flags.unlisted === true;
  const changelog = await readText(flag(context, "changelog"));
  const request = {
    type,
    target,
    name: flag(context, "name"),
    version: flag(context, "version"),
    changelog,
  };
  const outcome = await signedIn(context, () =>
    withMarket(context, async (ask) => {
      const draft = await createDraft(ask, request, publishConsent(context, unlisted));
      if (context.args.flags.draft === true) return { kind: "draft" as const, draft };
      return published(context, ask, draft, unlisted);
    }),
  );
  if (outcome.kind === "draft") {
    const answer = { kind: "draft" as const, draft: outcome.draft };
    return emit(context.args, answer, {
      human: () => publishLines(answer),
      quiet: () => [answer.draft.id],
    });
  }
  return finish(context, outcome);
}

export async function publishDraft(context: CommandContext): Promise<void> {
  const id = context.args.words[0] ?? "";
  const outcome = await signedIn(context, () =>
    withMarket(context, async (ask) => {
      const { answer } = answerOf(
        await ask({ op: "publish", request: { action: "draftRead", id } }),
        "publish",
      );
      if (answer.kind !== "draft") throw new CliFailure("failed", `There's no draft ${id}.`);
      return published(context, ask, answer.draft, false);
    }),
  );
  return finish(context, outcome);
}

export async function describe(context: CommandContext): Promise<void> {
  const ref = parseEntry(context.args.words[0]);
  const lists = context.args.lists ?? {};
  const description = await readText(flag(context, "description"));
  const answer = await signedIn(context, () =>
    withMarket(context, async (ask) => {
      const { answer: current } = answerOf(
        await ask({ op: "publish", request: { action: "entry", type: ref.type, name: ref.name } }),
        "publish",
      );
      if (current.kind !== "entry") throw new CliFailure("failed", "The entry didn't come back.");
      return ask(
        describeListing(current.entry.listing, {
          verb: "describe",
          type: ref.type,
          name: ref.name,
          ...(flag(context, "title") !== undefined ? { title: flag(context, "title") } : {}),
          ...(flag(context, "line") !== undefined ? { line: flag(context, "line") } : {}),
          ...(description !== undefined ? { description } : {}),
          ...(lists.category ? { categories: [...lists.category] } : {}),
          ...(lists.keyword ? { keywords: [...lists.keyword] } : {}),
          ...(lists.link ? { links: [...lists.link] } : {}),
        }),
      );
    }),
  );
  const out = printed(answer);
  return emit(context.args, out.value, out.render);
}

export async function avatar(context: CommandContext): Promise<void> {
  const path = context.args.words[0] ?? "";
  const image = Buffer.from(await readFile(path)).toString("base64");
  const answer = await signedIn(context, () =>
    withMarket(context, (ask) => ask({ op: "publish", request: { action: "setAvatar", image } })),
  );
  const out = printed(answer);
  return emit(context.args, out.value, out.render);
}
