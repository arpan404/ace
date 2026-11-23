import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test, vi } from "vitest";
import { Menu, MenuTrigger } from "@/components/ui/menu.tsx";
import { AccountMenuContent } from "./account-menu-content.tsx";

vi.mock("@tanstack/react-router", () => ({ useNavigate: () => () => {} }));
vi.mock("@/lib/layout.tsx", () => ({ useLayout: () => ({ setShortcutsOpen: () => {} }) }));
vi.mock("@/lib/profile.ts", () => ({ useProfileName: () => ["You"] }));
vi.mock("@/features/ace-account/index.ts", () => ({
  useAceAccount: () => ({}),
  useAceAccountStore: () => undefined,
  useAccountPicture: () => undefined,
}));
vi.mock("./daemon-menu-content.tsx", () => ({ DaemonMenuItems: () => null }));
vi.mock("./space-menu-items.tsx", () => ({ SpaceMenuItems: () => null }));

const row = (name: RegExp) => screen.findByRole("menuitem", { name });

test("the account menu checks, downloads, and confirms before restarting", async () => {
  let report: ((status: unknown) => void) | undefined;
  let state = { state: "idle", currentVersion: "1.0.0", inPlace: true };
  const publish = (patch: Record<string, unknown>) => {
    state = { ...state, ...patch };
    report?.(state);
    return state;
  };
  const pending = Promise.withResolvers<void>();
  let nextVersion: string | null = null;
  const install = vi.fn(async () => state);
  vi.stubGlobal("ace", {
    updates: {
      current: async () => state,
      onStatus(listener: typeof report) {
        report = listener;
        return () => undefined;
      },
      async check() {
        publish({ state: "checking" });
        await pending.promise;
        return publish({ state: nextVersion ? "available" : "current", version: nextVersion });
      },
      async download() {
        return publish({ state: "downloading", percent: 42 });
      },
      busy: async () => 0,
      install,
    },
  });

  try {
    render(
      <Menu>
        <MenuTrigger>Account</MenuTrigger>
        <AccountMenuContent />
      </Menu>,
    );
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Account" }));
    await user.click(await row(/Check for updates/));
    expect(await row(/Checking…/)).toBeTruthy();
    await act(async () => pending.resolve());
    expect(await screen.findByText("ace is up to date")).toBeTruthy();

    nextVersion = "1.1.0";
    await user.click(await row(/Check for updates/));
    await user.click(await row(/Update to 1.1.0/));
    expect(await row(/Downloading update \(42%\)/)).toBeTruthy();
    act(() => {
      publish({ state: "downloaded" });
    });
    await user.click(await row(/Restart to update/));
    expect(await screen.findByRole("dialog", { name: "Restart to update?" })).toBeTruthy();
    expect(install).not.toHaveBeenCalled();
    await user.click(await screen.findByRole("button", { name: "Restart" }));
    expect(install).toHaveBeenCalledOnce();
  } finally {
    vi.unstubAllGlobals();
  }
});
