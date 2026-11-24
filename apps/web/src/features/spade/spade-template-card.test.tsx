import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { spadeApp, withEndpoint } from "@/test/spade.ts";

test.each([
  { button: "Publish", confirm: "Confirm publication", visibility: "listed" },
  { button: "Share link", confirm: "Confirm link sharing", visibility: "unlisted" },
])(
  "$button sends only the reviewed version after confirmation",
  async ({ button, confirm, visibility }) => {
    const id = "template_benchmark";
    const { app, spade } = await spadeApp("/spade/benchmarks", (api) => {
      withEndpoint(api);
      const bot = api.addAgent({ id: "benchmarks", name: "Benchmarks" });
      api.store(bot.conversation, { type: "reply_started", reply: "template-reply" });
      api.store(bot.conversation, {
        type: "card_shown",
        reply: "template-reply",
        call_id: "draft",
        card: id,
        version: 1,
        data: {
          title: "Benchmarks",
          blocks: [
            { kind: "fields", rows: [{ label: "Description", value: "Measure rendering speed." }] },
          ],
        },
      });
      api.store(bot.conversation, { type: "reply_finished", reply: "template-reply" });
      api.shareTemplates.set(id, {
        revision: "a".repeat(64),
        visibility: null,
        draft: {
          bot: "benchmarks",
          left_out: ["Conversation history stays here."],
          skills: [],
          recipe: {
            format: "spade-bot",
            version: 3,
            name: "Benchmarks",
            model: "capable",
            blurb: "Measure rendering speed.",
            task: "Measure a baseline.",
            notes: ["Use the same workload."],
            knowledge: [
              {
                kind: "playbook",
                title: "Profile in stages",
                topic: "rendering",
                body: "Separate parse time from rendering.",
              },
              {
                kind: "lesson",
                title: "Warm caches",
                topic: "rendering",
                body: "Compare cold and warm runs separately.",
              },
            ],
            skills: ["spade-skill/measure-renderer"],
            triggers: [{ kind: "message" }],
            needs: { connectors: [] },
          },
        },
      });
    });
    const card = within(await screen.findByRole("region", { name: "Bot template" }));
    expect(card.getByText("Unpublished")).toBeTruthy();
    expect(card.getByText("Measure rendering speed.")).toBeTruthy();
    expect(await card.findByText("measure-renderer")).toBeTruthy();
    expect(card.getByText("1 skill · 1 playbook · 1 lesson")).toBeTruthy();
    await userEvent.click(card.getByRole("button", { name: "View Details" }));
    const details = within(await screen.findByRole("dialog", { name: "Template details" }));
    expect(details.getByText("Use the same workload.")).toBeTruthy();
    expect(details.getByText("Conversation history stays here.")).toBeTruthy();
    await userEvent.click(details.getByRole("button", { name: "Close" }));
    await userEvent.click(card.getByRole("button", { name: button }));
    const review = within(await screen.findByRole("dialog", { name: "Template details" }));
    await userEvent.clear(review.getByRole("textbox", { name: "Task" }));
    await userEvent.type(review.getByRole("textbox", { name: "Task" }), "Compare medians.");
    await userEvent.click(review.getByRole("button", { name: "Remove note 1" }));
    await userEvent.click(review.getByRole("button", { name: "Remove Warm caches" }));
    expect(app.daemon.marketplace.templatePublications).toEqual([]);
    await userEvent.click(review.getByRole("button", { name: confirm }));
    await waitFor(() =>
      expect(app.daemon.marketplace.templatePublications).toEqual([
        expect.objectContaining({
          op: "publishTemplate",
          id,
          review: expect.objectContaining({
            revision: "a".repeat(64),
            visibility,
            task: "Compare medians.",
            notes: [],
            knowledge: [expect.objectContaining({ title: "Profile in stages" })],
          }),
        }),
      ]),
    );
    expect(spade.requests).toContainEqual(
      expect.objectContaining({ method: "GET", path: `/v1/share-templates/${id}` }),
    );
  },
);
