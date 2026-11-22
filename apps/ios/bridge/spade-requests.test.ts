import { expect, test } from "vitest";
import { z } from "zod";
// First: it installs the fake native host the bridge modules read as they load.
import { setUp } from "./spade-test-host.ts";
import { until } from "./test-host.ts";
import { NativeServices } from "./native-services.ts";
import { RecordingSink } from "./sheet-fixture.ts";
import { ImageBudget, imageBudgetBytes } from "./image-budget.ts";
import { answerFromAreas, spadeRequestArea } from "./spade-requests-area.ts";
import { spadeRequestAreas, spadeRequestContext } from "./spade-requests.ts";

/* What the iPhone asks of Spade goes to the one area that lists it. */

test("an area appended to the table answers its own request while the others still answer theirs", async () => {
  const { owner, spade } = await setUp();
  const context = spadeRequestContext(
    owner,
    spade,
    {
      id: () => crypto.randomUUID(),
      now: () => Date.now(),
      images: new ImageBudget(imageBudgetBytes),
      chunks: async () => "",
    },
    new AbortController().signal,
  );
  // A new area is one module like this and one line in the table.
  const noop = spadeRequestArea([z.object({ type: z.literal("spade.noop") })], async () => ({
    ok: true,
    noop: true,
  }));
  const table = [...spadeRequestAreas, noop];
  const unlisted = { type: "spade.profile", agentId: "nobody" };

  expect(await answerFromAreas<unknown>(table, context, { type: "spade.noop" })).toEqual({
    ok: true,
    noop: true,
  });
  expect(await answerFromAreas<unknown>(table, context, unlisted)).toEqual({
    ok: false,
    title: "",
    message: "Spade hasn't listed this bot yet.",
  });
});

test("a raw profile request from Swift is answered through the native service", async () => {
  const { owner, spade, patches } = await setUp((fake) => {
    fake.addAgent({ id: "writer", name: "Writer", task: "Draft the release notes." });
  });
  await until(() => patches.state?.list.rows?.some((row) => row.id === "writer") === true);
  const sink = new RecordingSink();
  const services = new NativeServices(owner, sink);
  services.spade = spade;

  services.handle({
    type: "service",
    id: "profile",
    request: { type: "spade.profile", agentId: "writer" },
  });

  await until(() => sink.read("service:profile") !== undefined);
  expect(sink.read("service:profile")).toMatchObject({
    ok: true,
    value: { ok: true, profile: { name: "Writer", details: { task: "Draft the release notes." } } },
  });
});
