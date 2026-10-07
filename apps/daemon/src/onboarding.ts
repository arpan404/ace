import { DatabaseSync } from "@ace/provider-kit/sqlite";
import { onboardingChecklist } from "@ace/core";
import { z } from "zod";
import type { ProviderStatuses } from "./provider-status.ts";
import type { OnboardingResult } from "@ace/protocol";

/** Only a device's dismissal flag is persisted. No login challenge enters this database. */
export class Onboarding {
  private db: DatabaseSync;
  private statuses: ProviderStatuses;
  constructor(path: string, statuses: ProviderStatuses) {
    this.db = new DatabaseSync(path);
    this.db.exec(
      "CREATE TABLE IF NOT EXISTS onboarding (device TEXT PRIMARY KEY, dismissed INTEGER NOT NULL)",
    );
    this.statuses = statuses;
  }
  query(device: string, requestId: string): OnboardingResult {
    const row = this.db.prepare("SELECT dismissed FROM onboarding WHERE device = ?").get(device);
    const dismissed = row ? z.object({ dismissed: z.number() }).parse(row).dismissed === 1 : false;
    return {
      type: "onboarding.result",
      requestId,
      result: { ok: true, dismissed, ...onboardingChecklist(this.statuses.list()) },
    };
  }
  dismiss(device: string, dismissed: boolean): void {
    const count = z
      .object({ total: z.number() })
      .parse(this.db.prepare("SELECT count(*) AS total FROM onboarding").get()).total;
    if (
      count >= 256 &&
      !this.db.prepare("SELECT device FROM onboarding WHERE device = ?").get(device)
    )
      throw new Error("Onboarding device capacity reached");
    this.db
      .prepare(
        "INSERT INTO onboarding VALUES (?, ?) ON CONFLICT(device) DO UPDATE SET dismissed = excluded.dismissed",
      )
      .run(device, dismissed ? 1 : 0);
  }
  close(): void {
    this.db.close();
  }
}
