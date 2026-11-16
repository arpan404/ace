import { sha256Hex } from "@ace/marketplace";
import { stripImage } from "@ace/marketplace/image";
import { displayNameProblem, handleProblem, linkProblem, skeleton } from "@ace/marketplace/profile";
import {
  MarketHandleChange,
  MarketPinsSet,
  MarketProfileCreate,
  MarketProfileEdit,
  MarketVerificationApply,
  type MarketLink,
  type MarketMe,
  type MarketProblem,
} from "@ace/protocol/marketplace";
import { draftRoute } from "./api-publish.ts";
import { authenticate, reauthMs, type Authed, type AuthOptions } from "./auth.ts";
import { meEntryRoute, storePicture } from "./api-me-entries.ts";
import { avatarKey, type Context } from "./context.ts";
import { failure, json, readCapped, readJson, refused } from "./http.ts";
import { isNewPublisher } from "./rules.ts";
import type { Route } from "./routes.ts";
import { draftBody, draftsOf } from "./store/drafts.ts";
import { touchEntries } from "./store/entries.ts";
import { ownEntrySummaries } from "./store/me-entries.ts";
import { limitsOf } from "./store/me-limits.ts";
import { acceptTransfer, deleteTransfer, transferById, transfersOf } from "./store/me-transfers.ts";
import {
  changeHandle,
  createProfile,
  handleTaken,
  ownListed,
  profileOf,
  publisherById,
  setAvatar,
  setPins,
  updateProfile,
  verifiedNames,
  type PublisherTable,
} from "./store/profiles.ts";
import {
  challengesOf,
  issueChallenge,
  recordCheck,
  verificationStatus,
} from "./store/verification.ts";
import { checkDomain, checkGithub } from "./verify-proofs.ts";

/*
 * The publisher's own routes under `/v1/me` (ADR 0173 §2 to §5, §13): profile, handle, avatar,
 * pins, drafts, publications, transfers, signals, appeals and verification. Every one needs a
 * market grant through `authenticate`; sensitive ones a recent sign-in; entry routes check the
 * entry's publisher is the account's on every request.
 */

const sensitiveKinds = new Set<Route["kind"]>([
  "me-handle",
  "me-entry-withdraw",
  "me-version-withdraw",
  "me-transfer",
  "me-transfer-accept",
  "me-verification-apply",
]);

function authOptions(route: Route): AuthOptions {
  return {
    sensitive: sensitiveKinds.has(route.kind),
    allowInactive: route.kind === "me" || route.kind === "me-verification",
  };
}

export const noProfile = () =>
  failure(409, "conflict", "Make your publisher profile before you publish.");
const invalid = (message: string) => failure(400, "invalid", message);
const done = () => json({ status: "done" });

/** A verified profile's edits need a recent sign-in (ADR 0173 §2). */
const staleForVerified = (authed: Authed, context: Context) =>
  authed.publisher?.verified === true && !(context.now - authed.claims.authAt <= reauthMs)
    ? failure(401, "reauth", "Sign in again to do this.")
    : undefined;

export async function meRoute(
  request: Request,
  url: URL,
  route: Route,
  context: Context,
): Promise<Response | undefined> {
  if (route.kind !== "me" && !route.kind.startsWith("me-")) return undefined;
  const authed = await authenticate(request, context, authOptions(route));
  if (authed instanceof Response) return authed;
  return (
    (await draftRoute(request, url, route, context, authed)) ??
    (await meEntryRoute(request, route, context, authed)) ??
    (await profileWrites(request, route, context, authed)) ??
    (await verification(request, route, context, authed)) ??
    (await transfers(route, context, authed))
  );
}

/* ---------------------------------------------------------------- your page */

async function mePage(context: Context, authed: Authed): Promise<Response> {
  const db = context.env.MARKET;
  const publisher = authed.publisher;
  if (!publisher) {
    const limits = await limitsOf(db, "", true, context.now);
    const body: MarketMe = {
      state: "active",
      newPublisher: true,
      limits,
      entries: [],
      drafts: [],
      transfers: [],
    };
    return json(body);
  }
  const row = await publisherById(db, publisher.id);
  if (!row) return noProfile();
  const newPublisher = isNewPublisher(publisher, context.now);
  const profile = profileOf(row);
  const [limits, entries, drafts, offers] = await Promise.all([
    limitsOf(db, publisher.id, newPublisher, context.now),
    ownEntrySummaries(db, publisher.id, profile.pins),
    draftsOf(db, publisher.id),
    transfersOf(db, publisher.id, context.now),
  ]);
  const body: MarketMe = {
    profile,
    state: publisher.state,
    newPublisher,
    limits,
    entries,
    drafts: await Promise.all(drafts.map((draft) => draftBody(context.env.OBJECTS, db, draft))),
    transfers: offers,
  };
  return json(body);
}

/* ---------------------------------------------------------------- profile */

function linksProblems(links: readonly MarketLink[]): MarketProblem[] {
  return links.flatMap((link) => {
    const problem = linkProblem(link);
    return problem ? [problem] : [];
  });
}

async function nameProblem(db: D1Database, name: string, official: boolean) {
  const verified = (await verifiedNames(db)).map((entry) => entry.displayName);
  return displayNameProblem(name, { official, verified });
}

async function handleRefusal(db: D1Database, handle: string, official: boolean, self?: string) {
  const problem = handleProblem(handle, { official });
  if (problem) return refused([problem]);
  if (await handleTaken(db, handle, skeleton(handle), self))
    return failure(409, "conflict", "That handle, or one that looks like it, is taken.");
  return undefined;
}

async function createOwnProfile(request: Request, context: Context, authed: Authed) {
  const db = context.env.MARKET;
  if (authed.publisher?.official)
    return failure(
      403,
      "forbidden",
      "This account publishes as ace and has no profile of its own.",
    );
  if (authed.publisher) return failure(409, "conflict", "This account already has a profile.");
  const parsed = MarketProfileCreate.safeParse(await readJson(request, 16 * 1024));
  if (!parsed.success)
    return invalid(
      "A profile needs a handle (3 to 32 lowercase letters, digits and single dashes) and a display name.",
    );
  const input = parsed.data;
  const taken = await handleRefusal(db, input.handle, false);
  if (taken) return taken;
  const problems = linksProblems(input.links);
  const name = await nameProblem(db, input.displayName, false);
  if (name) problems.push(name);
  if (problems.length > 0) return refused(problems);
  const id = context.newId("pub");
  const made = await createProfile(db, {
    id,
    account: authed.account,
    handle: input.handle,
    skeleton: skeleton(input.handle),
    displayName: input.displayName,
    bio: input.bio,
    links: input.links,
    now: context.now,
  });
  if (!made) return failure(409, "conflict", "That handle, or one that looks like it, is taken.");
  const row = await publisherById(db, id);
  return row ? json(profileOf(row), 201) : noProfile();
}

async function profileWrites(
  request: Request,
  route: Route,
  context: Context,
  authed: Authed,
): Promise<Response | undefined> {
  const db = context.env.MARKET;
  const publisher = authed.publisher;
  switch (route.kind) {
    case "me":
      return mePage(context, authed);
    case "me-profile-create":
      return createOwnProfile(request, context, authed);
    case "me-profile-edit": {
      if (!publisher) return noProfile();
      const stale = staleForVerified(authed, context);
      if (stale) return stale;
      const parsed = MarketProfileEdit.safeParse(await readJson(request, 16 * 1024));
      if (!parsed.success) return invalid("That isn't a change to a profile.");
      const problems = linksProblems(parsed.data.links ?? []);
      if (parsed.data.displayName !== undefined) {
        const name = await nameProblem(db, parsed.data.displayName, publisher.official);
        if (name) problems.push(name);
      }
      if (problems.length > 0) return refused(problems);
      await updateProfile(db, publisher.id, parsed.data);
      const row = await publisherById(db, publisher.id);
      return row ? json(profileOf(row)) : noProfile();
    }
    case "me-handle": {
      if (!publisher) return noProfile();
      if (publisher.official) return failure(403, "forbidden", "ace's handle doesn't change.");
      const parsed = MarketHandleChange.safeParse(await readJson(request, 4 * 1024));
      if (!parsed.success)
        return invalid("A handle is 3 to 32 lowercase letters, digits and single dashes.");
      const handle = parsed.data.handle;
      if (handle === publisher.name) return done();
      const refusal = await handleRefusal(db, handle, false, publisher.id);
      if (refusal) return refusal;
      const row = await publisherById(db, publisher.id);
      if (!row) return noProfile();
      const moved = await changeHandle(
        db,
        { id: row.id, name: row.name },
        { handle, skeleton: skeleton(handle) },
      );
      if (moved === "taken")
        return failure(409, "conflict", "That handle, or one that looks like it, is taken.");
      if (moved === "stale")
        return failure(
          409,
          "conflict",
          "Your handle changed while this was on its way; try again.",
        );
      await touchOwn(db, publisher.id, context.now);
      const after = await publisherById(db, publisher.id);
      return after ? json(profileOf(after)) : noProfile();
    }
    case "me-avatar": {
      if (!publisher) return noProfile();
      const stale = staleForVerified(authed, context);
      if (stale) return stale;
      const bytes = await readCapped(request, 512 * 1024);
      if (!bytes) return failure(413, "too_large", "A picture here is at most 512 KB.");
      const image = stripImage(bytes, "avatar");
      if ("problem" in image) return refused([image.problem]);
      const sha = sha256Hex(image.bytes);
      const unstored = await storePicture(context, publisher, avatarKey(sha), image);
      if (unstored) return unstored;
      await setAvatar(db, publisher.id, sha);
      return json({ status: "done", avatar: sha });
    }
    case "me-pins": {
      if (!publisher) return noProfile();
      const parsed = MarketPinsSet.safeParse(await readJson(request, 16 * 1024));
      if (!parsed.success) return invalid("Pins are at most 6 of your listed entries.");
      const pins = parsed.data.entries;
      const keys = pins.map((pin) => `${pin.type}/${pin.name}`);
      if (new Set(keys).size !== keys.length) return invalid("An entry is pinned twice.");
      const own = await ownListed(db, publisher.id, pins);
      const others = pins.filter((pin) => !own.has(`${pin.type}/${pin.name}`));
      if (others.length > 0)
        return refused(
          others.map((pin) => ({
            message: `${pin.type}/${pin.name} isn't one of your listed entries`,
          })),
        );
      if (!(await setPins(db, publisher.id, pins)))
        return failure(403, "forbidden", "One of these entries isn't yours and listed any more.");
      return done();
    }
    default:
      return undefined;
  }
}

/** A new handle reaches the index: every listed entry of the publisher gets a new stamp. */
async function touchOwn(db: D1Database, publisher: string, now: number) {
  const { results } = await db
    .prepare("SELECT type, name FROM entries WHERE publisher = ?1 AND listed = 1")
    .bind(publisher)
    .all<{ type: string; name: string }>();
  await touchEntries(db, results, now);
}

/* ---------------------------------------------------------------- verification */

async function verification(
  request: Request,
  route: Route,
  context: Context,
  authed: Authed,
): Promise<Response | undefined> {
  if (!route.kind.startsWith("me-verification")) return undefined;
  const db = context.env.MARKET;
  if (!authed.publisher) return noProfile();
  const row = await publisherById(db, authed.publisher.id);
  if (!row) return noProfile();
  const status = async (publisher: PublisherTable) =>
    json(verificationStatus(publisher, await challengesOf(db, publisher.id)));
  switch (route.kind) {
    case "me-verification":
      return status(row);
    case "me-verification-apply": {
      const parsed = MarketVerificationApply.safeParse(await readJson(request, 4 * 1024));
      if (!parsed.success || (!parsed.data.domain && !parsed.data.github))
        return invalid("Name a domain to prove, and optionally a GitHub account.");
      if (parsed.data.domain)
        await issueChallenge(db, {
          publisher: row.id,
          kind: "domain",
          subject: parsed.data.domain,
          token: context.newToken(),
          now: context.now,
        });
      if (parsed.data.github)
        await issueChallenge(db, {
          publisher: row.id,
          kind: "github",
          subject: parsed.data.github,
          token: context.newToken(),
          now: context.now,
        });
      return status(row);
    }
    case "me-verification-check": {
      for (const challenge of await challengesOf(db, row.id)) {
        if (challenge.state === "passed") continue;
        const outcome =
          challenge.expires <= context.now
            ? { problem: "This token expired; apply again for a new one." }
            : challenge.kind === "domain"
              ? await checkDomain(challenge.subject, challenge.token, context.fetch)
              : await checkGithub(challenge.subject, challenge.token, context.fetch);
        await recordCheck(db, row.id, challenge, outcome, context.now);
      }
      return status((await publisherById(db, row.id)) ?? row);
    }
    default:
      return undefined;
  }
}

/* ---------------------------------------------------------------- transfers */

async function transfers(
  route: Route,
  context: Context,
  authed: Authed,
): Promise<Response | undefined> {
  if (route.kind !== "me-transfer-accept" && route.kind !== "me-transfer-decline") return undefined;
  const db = context.env.MARKET;
  const transfer = await transferById(db, route.id);
  if (
    !transfer ||
    transfer.to_publisher !== authed.publisher?.id ||
    transfer.expires <= context.now
  )
    return failure(404, "not_found", "No such offer.");
  if (route.kind === "me-transfer-decline") {
    await deleteTransfer(db, transfer.id);
    return done();
  }
  if (!(await acceptTransfer(db, transfer, context.now)))
    return failure(409, "conflict", "That offer no longer stands.");
  return done();
}
