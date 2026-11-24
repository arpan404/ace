import { z } from "zod";

export const maxActivityBody = 1024;
const maxDismissAfter = 4 * 60 * 60;
const count = z.int().transform((value) => Math.max(0, Math.min(999, value)));
const state = z.strictObject({
  seq: z.int().nonnegative(),
  at: z.int().nonnegative(),
  phase: z.enum(["busy", "settled"]),
  needsYou: count,
  working: count,
  failed: count,
  waiting: count,
  limited: count,
  background: count,
  done: count,
});
const common = {
  v: z.literal(1),
  timestamp: z
    .int()
    .nonnegative()
    .max(Number.MAX_SAFE_INTEGER - maxDismissAfter),
  priority: z.literal([5, 10]),
  staleAfter: z.int().min(60).max(3600),
  state,
};
export const ActivityBody = z.discriminatedUnion("event", [
  z.strictObject({ ...common, event: z.literal("start"), slot: z.int().min(0).max(15) }),
  z.strictObject({ ...common, event: z.literal("update") }),
  z.strictObject({
    ...common,
    event: z.literal("end"),
    dismissAfter: z.int().min(0).max(maxDismissAfter),
  }),
]);

export function activityPush(body: z.infer<typeof ActivityBody>) {
  const expiration = body.timestamp + body.staleAfter;
  const payload = Buffer.from(
    JSON.stringify({
      aps: {
        timestamp: body.timestamp,
        event: body.event,
        "content-state": body.state,
        "stale-date": expiration,
        ...(body.event === "start"
          ? {
              "input-push-token": 1,
              "attributes-type": "MachineActivityAttributes",
              attributes: { slot: body.slot, version: 1 },
              alert: { title: "ace", body: "An agent started working" },
            }
          : {}),
        ...(body.event === "end" ? { "dismissal-date": body.timestamp + body.dismissAfter } : {}),
      },
    }),
  );
  return { priority: body.priority, expiration, payload };
}
