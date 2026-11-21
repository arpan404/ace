import type { AceOrgPortalIntent, AceOrgSpace } from "@ace/protocol/ace-org";
import { useState } from "react";
import { openExternalWhenReady } from "@/boot/open-external.ts";
import { SettingNote, SettingRow, SettingSection } from "@/components/setting-row.tsx";
import { Button } from "@/components/ui/button.tsx";
import { orgFailure, usePortalLink } from "@/features/ace-org/index.ts";

/** Each setup task the Admin Portal does for the organization, as its row says it. */
const tasks: readonly { intent: AceOrgPortalIntent; title: string; description: string }[] = [
  {
    intent: "domain_verification",
    title: "Email domain",
    description:
      "Prove your team's domain with a DNS record. With it, people on it can join as members when they sign in.",
  },
  {
    intent: "sso",
    title: "Single sign-on",
    description:
      "Sign in through your identity provider (SAML or OIDC). Once it's set up, members sign in only that way.",
  },
  {
    intent: "dsync",
    title: "Directory",
    description:
      "Add and remove members from your directory (SCIM). Roles it sets can't be changed in ace.",
  },
];

/**
 * Settings › Organization › Sign-in (ADR 0206 §1.3, §2.7): the organization's domain, single
 * sign-on and directory, each set up in the WorkOS Admin Portal. ace adds no sign-in rules of its
 * own. A link lasts five minutes and is tied to the admin who opened it, so removing them ends it.
 */
export function SignInPage(props: { org: AceOrgSpace }) {
  const portal = usePortalLink(props.org.id);
  const [error, setError] = useState("");
  return (
    <SettingSection
      label="Sign-in"
      anchor="org.signIn"
      note="Each opens WorkOS's setup page in your browser for a few minutes."
    >
      {tasks.map((task) => (
        <SettingRow key={task.intent} title={task.title} description={task.description} inline>
          <Button
            size="sm"
            variant="ghost"
            disabled={portal.isPending}
            onClick={() => {
              setError("");
              void openExternalWhenReady(
                portal.mutateAsync(task.intent).then((answer) => answer.link),
              ).catch((cause: unknown) => setError(orgFailure(cause)));
            }}
          >
            Set up
          </Button>
        </SettingRow>
      ))}
      {error && (
        <SettingNote role="alert" className="text-destructive">
          {error}
        </SettingNote>
      )}
    </SettingSection>
  );
}
