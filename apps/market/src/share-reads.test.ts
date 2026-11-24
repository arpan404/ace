import { opaqueWithdrawalId, verifyWithdrawn, withdrawalReason } from "@ace/marketplace";
import { keySetOf, signedWithdrawn, testKey } from "@ace/marketplace/testing";
import { createHash, createPrivateKey, createPublicKey, sign } from "node:crypto";
import { grantPublicKey, signMarketGrant } from "@ace/account-grant";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { URL as FileUrl } from "node:url";
import { expect, test } from "vitest";
import { meRoute } from "./api-me.ts";
import { configuredKeys } from "./grant-keys.ts";
import { discoverRoute } from "./api-discover.ts";
import { readRoute } from "./api-read.ts";
import type { Context } from "./context.ts";
import { matchRoute } from "./routes.ts";
import { shareId } from "./share-id.ts";

test("migration 0004 backfills only public unlisted bots and skills", () => {
  const sql = new DatabaseSync(":memory:");
  const migrations = new FileUrl("../migrations/catalogue/", import.meta.url);
  try {
    const files = readdirSync(migrations).toSorted();
    for (const file of files.filter((file) => file < "0004"))
      sql.exec(readFileSync(new FileUrl(file, migrations), "utf8"));
    sql.exec(`
      INSERT INTO publisher_copies (id, name, state, verified, created, revision)
        VALUES ('pub', 'owner', 'active', 0, 1, 1);
      INSERT INTO entries (type, name, publisher, visibility, audience) VALUES
        ('spade-bot', 'bot', 'pub', 'unlisted', 'public'),
        ('spade-skill', 'skill', 'pub', 'unlisted', 'public'),
        ('spade-skill', 'public', 'pub', 'listed', 'public'),
        ('spade-skill', 'org', 'pub', 'unlisted', 'org:test'),
        ('suit', 'suit', 'pub', 'unlisted', 'public');
    `);
    sql.exec(readFileSync(new FileUrl("0004_share_ids.sql", migrations), "utf8"));
    const shared = sql
      .prepare("SELECT name, share_id FROM entries WHERE share_id IS NOT NULL ORDER BY name")
      .all();
    expect(shared).toEqual(
      ["bot", "skill"].map((name) => ({
        name,
        share_id: expect.stringMatching(
          /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
        ),
      })),
    );
    expect(new Set(shared.map((row) => row.share_id)).size).toBe(2);
    expect(sql.prepare("SELECT COUNT(*) AS count FROM entries").get()?.count).toBe(5);
  } finally {
    sql.close();
  }
});

test("migration 0005 preserves signed versions and pending withdrawals in a populated catalogue", () => {
  const sql = new DatabaseSync(":memory:");
  const migrations = new FileUrl("../migrations/catalogue/", import.meta.url);
  try {
    for (const file of readdirSync(migrations)
      .toSorted()
      .filter((file) => file < "0005"))
      sql.exec(readFileSync(new FileUrl(file, migrations), "utf8"));
    sql.exec(`
      INSERT INTO publisher_copies (id, name, state, verified, created, revision)
        VALUES ('pub', 'owner', 'active', 0, 1, 1);
      INSERT INTO entries (type, name, publisher, visibility, share_id)
        VALUES ('spade-skill', 'archive', 'pub', 'unlisted', '018bcfe5-6800-7000-8000-000000000001');
      INSERT INTO versions (type, name, version, hash, size, published, listing, listed, manifest, withdrawn)
        VALUES ('spade-skill', 'archive', '1.0.0', 'old', 5, 1, '{}', 1, 'signed old', 'Revoked'),
               ('spade-skill', 'archive', '2.0.0', 'new', 8, 2, '{}', 1, 'signed new', NULL);
      INSERT INTO pending_withdrawals (type, name, version, hash, reason, at)
        VALUES ('spade-skill', 'archive', '2.0.0', 'new', 'Pending revoke', 3);
    `);
    const entries = sql.prepare("SELECT * FROM entries").all();
    const versions = sql.prepare("SELECT * FROM versions ORDER BY version").all();
    const pending = sql.prepare("SELECT * FROM pending_withdrawals").all();
    sql.exec(readFileSync(new FileUrl("0005_opaque_withdrawals.sql", migrations), "utf8"));
    expect(sql.prepare("SELECT * FROM entries").all()).toEqual(entries);
    expect(sql.prepare("SELECT * FROM versions ORDER BY version").all()).toEqual(
      versions.map((row) => ({ ...row, withdrawal_id: null })),
    );
    expect(sql.prepare("SELECT * FROM pending_withdrawals").all()).toEqual(pending);
    sql.exec("UPDATE versions SET withdrawal_id = 'opaque' WHERE version = '1.0.0'");
    const lookup = "SELECT hash, withdrawn FROM versions WHERE withdrawal_id = 'opaque'";
    expect(sql.prepare(lookup).get()).toEqual({ hash: "old", withdrawn: "Revoked" });
    expect(sql.prepare("EXPLAIN QUERY PLAN " + lookup).get()?.detail).toContain(
      "versions_withdrawal_id",
    );
  } finally {
    sql.close();
  }
});

function database(name: "catalogue" | "counts" | "publishers" | "moderation" | "lists") {
  const sql = new DatabaseSync(":memory:");
  const migrations = new FileUrl(`../migrations/${name}/`, import.meta.url);
  for (const file of readdirSync(migrations).toSorted())
    sql.exec(readFileSync(new FileUrl(file, migrations), "utf8"));
  // Pass the Worker's actual SQL to SQLite. D1 adds async binding and an envelope to these reads.
  const binding = {
    prepare(query: string) {
      const statement = sql.prepare(query.replace(/\?(\d+)/g, ":p$1"));
      const prepared = (values: readonly SQLInputValue[]) => {
        const args = Object.fromEntries(values.map((value, i) => [`:p${i + 1}`, value]));
        return {
          first: async () => (values.length ? statement.get(args) : statement.get()) ?? null,
          all: async () => ({ results: values.length ? statement.all(args) : statement.all() }),
          run: async () => ({ meta: statement.run(args) }),
          bind: (...values: SQLInputValue[]) => prepared(values),
        };
      };
      return prepared([]);
    },
  };
  return { sql, db: binding as unknown as D1Database };
}

test.each(["spade-bot", "spade-skill"] as const)(
  "an unlisted %s is readable by UUIDv7 and stays out of the catalogue",
  async (type) => {
    const catalogue = database("catalogue");
    const counts = database("counts");
    const moderation = database("moderation");
    const lists = database("lists");
    const publishers = database("publishers");
    try {
      const now = 1_700_000_000_000;
      const id = shareId(now, crypto.getRandomValues(new Uint8Array(10)));
      const hash = "a".repeat(64);
      const name = "private-archive";
      catalogue.sql.exec(
        "INSERT INTO publisher_copies (id, name, state, verified, created, revision) VALUES ('test', 'tester', 'active', 0, 1, 1)",
      );
      catalogue.sql
        .prepare(
          "INSERT INTO entries (type, name, publisher, title, visibility, share_id, listed) VALUES (?, ?, 'test', 'Private archive', 'unlisted', ?, 1)",
        )
        .run(type, name, id);
      catalogue.sql
        .prepare(
          "INSERT INTO versions (type, name, version, hash, size, published, listing, listed, manifest) VALUES (?, ?, '1.0.0', ?, 5, 1, '{}', 1, ?)",
        )
        .run(type, name, hash, JSON.stringify({ payload: "signed", signature: "signature" }));
      const context = {
        now,
        newId: () => "rpt_private",
        dbs: {
          catalogue: (requested: string) => (requested === type ? catalogue.db : undefined),
          catalogues: [{ type, db: catalogue.db }],
          counts: counts.db,
          moderation: moderation.db,
          lists: lists.db,
          publishers: publishers.db,
        },
      } as unknown as Context;
      const fetch = async (path: string) => {
        const url = new URL(path, "https://market.example");
        const matched = matchRoute("GET", url.pathname);
        if ("refused" in matched) return new Response(null, { status: matched.refused });
        return readRoute(new Request(url), url, matched.route, context);
      };
      expect((await fetch(`/v1/entries/${type}/${name}`))?.status).toBe(404);
      expect((await fetch(`/v1/entries/${type}/${name}/1.0.0`))?.status).toBe(404);
      expect((await fetch(`/v1/objects/${hash}`))?.status).toBe(404);
      expect((await fetch(`/i/${name}`))?.status).toBe(404);
      const report = (key: object) => {
        const url = new URL("https://market.example/v1/reports");
        return discoverRoute(
          new Request(url, {
            method: "POST",
            body: JSON.stringify({ ...key, reason: "spam" }),
          }),
          url,
          { kind: "report" },
          context,
        );
      };
      expect((await report({ type, name }))?.status).toBe(404);
      expect((await report({ shareId: id }))?.status).toBe(202);

      const legacy = { type, name, hash, version: "1.0.0" };
      const writeWithdrawal = (signed: unknown) =>
        lists.sql
          .prepare("INSERT OR REPLACE INTO withdrawn (id, issued, signed) VALUES (1, ?, ?)")
          .run(now, JSON.stringify(signed));
      const key = testKey();
      const served = async () => {
        const response = await fetch("/v1/withdrawn");
        expect(response?.status).toBe(200);
        return verifyWithdrawn(await response?.json(), keySetOf(key));
      };
      writeWithdrawal(
        signedWithdrawn([{ ...legacy, reason: "Legacy withdrawal" }], { key, issued: now }),
      );
      expect(withdrawalReason((await served()).withdrawn, legacy)).toBe("Legacy withdrawal");
      writeWithdrawal(
        signedWithdrawn([{ hash: opaqueWithdrawalId(legacy), reason: "Withdrawn" }], {
          key,
          issued: now + 1,
        }),
      );
      const redacted = await served();
      expect(redacted.issued).toBe(now + 1);
      expect(withdrawalReason(redacted.withdrawn, legacy)).toBe("Withdrawn");
      expect(JSON.stringify(redacted)).not.toContain(name);
      const page = await fetch(`/i/${id}`);
      expect(await page?.json()).toMatchObject({ entry: { type, name }, versions: [{ hash }] });
      expect((await fetch(`/v1/i/${id}/versions/1.0.0`))?.status).toBe(200);
      expect(await (await fetch("/v1/index"))?.json()).toMatchObject({ entries: [] });
      const search = () => fetch(`/v1/search?q=${name}&publisher=tester`);
      expect(await (await search())?.json()).toMatchObject({ entries: [], total: 0 });
      catalogue.sql.exec("UPDATE entries SET visibility = 'listed', listed = 1");
      expect(await (await search())?.json()).toMatchObject({ entries: [{ type, name }], total: 1 });
      expect((await fetch(`/i/${id}`))?.status).toBe(404);
    } finally {
      catalogue.sql.close();
      counts.sql.close();
      moderation.sql.close();
      lists.sql.close();
      publishers.sql.close();
    }
  },
);

test.each([
  ["spade-bot", `template-${"a".repeat(32)}`],
  ["spade-skill", "measure"],
] as const)(
  "a matching hash and machine grant cannot publish an unlisted %s",
  async (type, name) => {
    const publishers = database("publishers");
    const catalogue = database("catalogue");
    try {
      const now = 1_700_000_000_000;
      const account = "acct_tester";
      const publisher = "pub_tester";
      const hash = "a".repeat(64);
      const draft = "drf_abcdefgh";
      const version = type === "spade-skill" ? "1.2.0" : "1.0.0";
      const key = { id: "test", privateKey: new Uint8Array(32).fill(3) };
      const grant = signMarketGrant(
        {
          kind: "machine",
          account,
          subject: "host-test",
          iss: "cloud.acehq.dev",
          emailVerified: true,
          authAt: now,
          iat: now,
          exp: now + 60_000,
        },
        key,
      );
      publishers.sql
        .prepare("INSERT INTO publishers (id, account, name, created) VALUES (?, ?, 'tester', ?)")
        .run(publisher, account, now);
      publishers.sql
        .prepare(
          "INSERT INTO drafts (id, publisher, type, name, version, hash, size, files, title, scan_state, verdict, created, updated) VALUES (?, ?, ?, ?, ?, ?, 5, 1, 'Private archive', 'done', 'pass', ?, ?)",
        )
        .run(draft, publisher, type, name, version, hash, now, now);
      const context = {
        now,
        env: {
          OBJECTS: {
            get: async (key: string) =>
              key.startsWith("reports/drafts/")
                ? { json: async () => ({ hash, verdict: "pass" }) }
                : null,
          },
        },
        grantKeys: configuredKeys(JSON.stringify({ keys: [grantPublicKey(key)] })),
        dbs: {
          publishers: publishers.db,
          catalogue: () => catalogue.db,
          catalogues: [{ type, db: catalogue.db }],
        },
      } as unknown as Context;
      const url = new URL(`https://market.example/v1/me/drafts/${draft}/publish`);
      url.search = new URLSearchParams({
        visibility: "unlisted",
        publisher,
        template: name,
        version,
        reviewed: hash,
      }).toString();
      const matched = matchRoute("POST", url.pathname);
      if ("refused" in matched) throw new Error("Missing publish route.");
      const response = await meRoute(
        new Request(url, { method: "POST", headers: { authorization: `Bearer ${grant}` } }),
        url,
        matched.route,
        context,
      );
      expect(response?.status).toBe(401);
      expect(await response?.json()).toMatchObject({ error: "person_grant" });
      const seed = Buffer.alloc(32, 3);
      const privateKey = createPrivateKey({
        key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), seed]),
        format: "der",
        type: "pkcs8",
      });
      const publicKey = createPublicKey(privateKey)
        .export({ format: "der", type: "spki" })
        .subarray(-32)
        .toString("hex");
      context.env.SPADE_REVIEW_PUBLIC_KEYS = JSON.stringify({ [publisher]: [publicKey] });
      const asPerson = (url: URL, issued = now) => {
        const action = `POST ${url.pathname}${url.search} ${createHash("sha256").digest("base64url")}`;
        const grant = signMarketGrant(
          {
            kind: "device",
            account,
            subject: "app",
            iss: "cloud.acehq.dev",
            emailVerified: true,
            authAt: now,
            iat: issued,
            exp: issued + 60_000,
            action,
          },
          key,
        );
        return meRoute(
          new Request(url, { method: "POST", headers: { authorization: `Bearer ${grant}` } }),
          url,
          matched.route,
          context,
        );
      };
      expect((await asPerson(url))?.status).toBe(403);
      const items = "b".repeat(64);
      const attest = (bound: string) => {
        const statement = JSON.stringify([
          "ace-spade-market-review/1",
          type,
          publisher,
          name,
          version,
          hash,
          "unlisted",
          bound,
          items,
        ]);
        return `${items}.${sign(null, Buffer.from(statement), privateKey).toString("hex")}`;
      };
      url.searchParams.set("reviewProof", attest("drf_different"));
      expect((await asPerson(url))?.status).toBe(403);
      url.searchParams.set("reviewProof", attest(draft));
      const acceptedProof = await asPerson(url);
      expect(acceptedProof?.status).toBe(409);
      expect(await acceptedProof?.json()).toMatchObject({
        message: expect.stringContaining("archive is missing"),
      });
      expect((await asPerson(url))?.status).toBe(401);
      if (type === "spade-skill") {
        catalogue.sql
          .prepare(
            "INSERT INTO publisher_copies (id, name, state, verified, created, revision) VALUES (?, 'tester', 'active', 0, 1, 1)",
          )
          .run(publisher);
        catalogue.sql
          .prepare(
            "INSERT INTO entries (type, name, publisher, visibility) VALUES (?, ?, ?, 'unlisted')",
          )
          .run(type, name, publisher);
        catalogue.sql
          .prepare(
            "INSERT INTO versions (type, name, version, hash, size, published, listing) VALUES (?, ?, '2.0.0', ?, 5, 1, '{}')",
          )
          .run(type, name, hash);
        const stale = await asPerson(url, now - 1);
        expect(stale?.status).toBe(409);
        expect(await stale?.json()).toMatchObject({
          message: expect.stringContaining("Choose a version newer"),
        });
      }
    } finally {
      publishers.sql.close();
      catalogue.sql.close();
    }
  },
);
