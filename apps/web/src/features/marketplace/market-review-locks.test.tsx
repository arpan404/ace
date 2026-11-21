import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { expect, test } from "vitest";
import type { AceOrgPolicy } from "@ace/protocol/ace-org";
import { effectLock } from "@/features/ace-org/index.ts";
import { RecipeChoices } from "./market-review-bot.tsx";

/*
 * The install review on an org host (ADR 0206 §3, §5.4): an effect the organization's policy
 * turns off, or keeps for admins, is a locked switch for a member, and says why. Paying, sending
 * in someone's name and publishing are admins' to turn on whatever the policy says.
 */

const recipe = {
  type: "spade-bot" as const,
  botName: "CI watcher",
  task: "You watch CI.",
  model: "fast" as const,
  routines: [],
  notes: [],
  brings: [],
  needs: [],
  spadeReady: true,
  linked: true,
  effects: [
    { key: "pay", effect: "pay" as const, why: "Renews the runner plan." },
    { key: "publish", effect: "publish" as const, why: "Posts the weekly CI report." },
    { key: "change_access", effect: "change_access" as const, why: "Adds a reviewer." },
    {
      key: "network:hosts:api.github.com",
      effect: "network" as const,
      hosts: ["api.github.com"],
      why: "Reads check runs.",
    },
  ],
};

const policy: AceOrgPolicy = { effects: { pay: "off", change_access: "admins" } };

function Review(props: { role: string }) {
  const [effects, setEffects] = useState<Record<string, boolean>>({});
  return (
    <RecipeChoices
      recipe={recipe}
      byAce
      lockOf={(row) =>
        effectLock({
          policy,
          orgName: "Acme Robotics",
          role: props.role,
          effect: row.effect,
          namesHosts: (row.hosts?.length ?? 0) > 0,
        })
      }
      needs={{}}
      onNeeds={() => {}}
      effects={effects}
      onEffects={(next) => setEffects(next)}
      start={false}
      onStart={() => {}}
    />
  );
}

const toggle = (name: string) => screen.getByRole("switch", { name });

test("a member's switches above their role are locked off and say why; what they may turn on works", async () => {
  render(<Review role="member" />);
  const pay = toggle("Can ask you to pay");
  expect(pay.getAttribute("aria-checked")).toBe("false");
  expect(pay.hasAttribute("data-disabled")).toBe(true);
  expect(screen.getByText("Acme Robotics doesn't allow paying.")).toBeDefined();
  // Kept for admins by the policy, and publishing for every member.
  expect(screen.getAllByText("Your organization lets only admins turn this on.")).toHaveLength(2);
  await userEvent.click(toggle("Publishes and posts"));
  expect(toggle("Publishes and posts").getAttribute("aria-checked")).toBe("false");
  // Reaching the sites it names is the member's to allow.
  const reach = toggle("Reaches api.github.com");
  await userEvent.click(reach);
  expect(toggle("Reaches api.github.com").getAttribute("aria-checked")).toBe("true");
});

test("an admin may turn on what the policy keeps for admins, but never what it turns off", async () => {
  render(<Review role="admin" />);
  expect(screen.queryByText("Your organization lets only admins turn this on.")).toBeNull();
  await userEvent.click(toggle("Publishes and posts"));
  expect(toggle("Publishes and posts").getAttribute("aria-checked")).toBe("true");
  expect(toggle("Can ask you to pay").hasAttribute("data-disabled")).toBe(true);
  expect(screen.getByText("Acme Robotics doesn't allow paying.")).toBeDefined();
});
