import { render, screen } from "@testing-library/react";
import { expect, test } from "vitest";
import { SafeModeNotice } from "./safe-mode-notice.tsx";

const sentence =
  "ace is running without the part that kept it from starting; restart ace to turn it back on.";

/** The desktop preload's `window.ace.daemon`, reporting `status`. */
function desktop(status: unknown) {
  return {
    ace: {
      platform: "darwin",
      daemon: {
        connection: () => Promise.resolve(undefined),
        status: () => Promise.resolve(status),
        onStatus: () => () => {},
      },
    },
  };
}

test("a daemon running in safe mode says what it runs without", async () => {
  render(<SafeModeNotice scope={desktop({ state: "running", message: sentence })} />);
  expect(await screen.findByText(sentence)).toBeTruthy();
});

test("a healthy daemon shows nothing", async () => {
  const { container } = render(<SafeModeNotice scope={desktop({ state: "running" })} />);
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(container.textContent).toBe("");
});
