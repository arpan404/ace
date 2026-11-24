import { grantPublicKey, signMarketGrant } from "@ace/account-grant";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { URL as FileUrl } from "node:url";
import { expect, test } from "vitest";
import { meRoute } from "./api-me.ts";
import { configuredKeys } from "./grant-keys.ts";
import { readRoute } from "./api-read.ts";
import type { Context } from "./context.ts";
import { matchRoute } from "./routes.ts";
import { shareId } from "./share-id.ts";

function database(name: "catalogue" | "counts" | "publishers") {
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
        dbs: {
          catalogue: (requested: string) => (requested === type ? catalogue.db : undefined),
          catalogues: [{ type, db: catalogue.db }],
          counts: counts.db,
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
          "INSERT INTO drafts (id, publisher, type, name, version, hash, size, files, title, scan_state, verdict, created, updated) VALUES (?, ?, ?, ?, '1.0.0', ?, 5, 1, 'Private archive', 'done', 'pass', ?, ?)",
        )
        .run(draft, publisher, type, name, hash, now, now);
      const context = {
        now,
        env: {},
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
        version: "1.0.0",
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
    } finally {
      publishers.sql.close();
      catalogue.sql.close();
    }
  },
);
