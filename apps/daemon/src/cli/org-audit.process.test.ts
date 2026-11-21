import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { shippedGrantKeys } from "@ace/account-grant/keys";
import { personHeader, personStamp } from "../spade/person-stamp.ts";
import { canRunSpade, spadeProgram, startThrowawaySpade } from "./bot-kit-test-support.ts";
import { directExchange } from "./bot-kit/dev.ts";
import { exportAudit, verifyAudit } from "./org-audit.ts";

/** A row the daemon records itself: who enrolled the host. */
const entry = (id: string) => ({
  action: "org.host.enrolled",
  occurredAt: Date.now(),
  actor: { type: "member", id },
  targets: [{ type: "host", id: "HOSTAUDIT" }],
});

// `ace org audit export|verify` (ADR 0206 §4.2) against a real Spade on an org host: the log it
// exports verifies offline with Spade's own check, and a file edited afterwards doesn't.

it.skipIf(!canRunSpade)(
  "an org host's exported audit log verifies offline, and an edited entry no longer does",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "ace-org-audit-"));
    const aceHome = join(root, "ace");
    await mkdir(aceHome);
    const key = randomBytes(32);
    await writeFile(join(aceHome, "spade-person.key"), key.toString("hex"));
    const spade = await startThrowawaySpade(root, { SPADE_ACE_HOME: aceHome });
    try {
      const exchange = await directExchange(spade.data);
      // A Spade that belongs to no organization has no log to give.
      await expect(exportAudit(exchange, {})).rejects.toThrow(/doesn't belong to an organization/);

      const org = "org_01AUDITTEAM";
      const stamp = personStamp(key, { target: "org", value: org }, Date.now(), "a1".repeat(16));
      const bound = await fetch(`http://${spade.connection.address}/v1/org`, {
        method: "PUT",
        headers: {
          authorization: `Bearer ${spade.connection.token}`,
          "content-type": "application/json",
          [personHeader]: stamp,
        },
        body: JSON.stringify({
          org,
          name: "Audit",
          host: "HOSTAUDIT",
          keys: shippedGrantKeys.keys,
        }),
      });
      expect(bound.status).toBe(200);
      const recorded = await spade.api("POST", "/v1/org/audit", {
        entries: [entry("user_pat"), entry("user_mia"), entry("user_lee")],
      });
      expect(recorded.status).toBe(200);

      const text = await exportAudit(exchange, { from: 0 });
      const file = join(root, "audit.jsonl");
      await writeFile(file, text);
      const auditKey = "4YnbPAZLpD557zJQT9bDShIgb4lSIpvda8dHoDmZPM8";
      expect(await verifyAudit(spadeProgram, file, auditKey)).toEqual({
        verified: true,
        said: expect.stringMatching(/^Verified: 3 entries/),
      });
      // Someone with the file rewrites who enrolled the host.
      const edited = (await readFile(file, "utf8")).replace("user_mia", "user_eve");
      await writeFile(file, edited);
      expect(await verifyAudit(spadeProgram, file, auditKey)).toEqual({
        verified: false,
        said: expect.stringMatching(/^Not verified: line/),
      });
    } finally {
      spade.stop();
      await rm(root, { recursive: true, force: true });
    }
  },
  60_000,
);
