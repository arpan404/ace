import { facts, replayCursor } from "@ace/fake-daemon";
import { act, screen, waitFor } from "@testing-library/react";
import { expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";

test("HTML in a normal assistant message is visible text and never an executing visualization", async () => {
  const app = harness();
  app.play(replayCursor()).runThrough("answered");
  const html =
    '<html><body><script>parent.document.body.textContent="escaped"</script><button>Run</button></body></html>';
  act(() =>
    app.daemon.apply("thread-replay-cursor", [
      facts.message("root", "plain-html", "assistant", html),
    ]),
  );
  await app.open("/t/thread-replay-cursor");
  const feed = await screen.findByRole("feed", { name: "Transcript" });
  await waitFor(() => expect(feed.textContent).toContain(html));
  expect(feed.querySelector("iframe")).toBeNull();
  expect(feed.querySelector("script")).toBeNull();
});
