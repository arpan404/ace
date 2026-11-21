import { orgAllows } from "@ace/client/ace-org";
import type { AceOrgSpace } from "@ace/protocol/ace-org";
import { lazy, Suspense, useState, type ReactNode } from "react";
import { openExternalWhenReady } from "@/boot/open-external.ts";
import { SettingCard, SettingNote, SettingRow } from "@/components/setting-row.tsx";
import { Button } from "@/components/ui/button.tsx";
import { useAceAccountStore, useSpace } from "@/features/ace-account/index.ts";
import {
  organizationPageNeeds,
  SettingsBody,
  type SettingsPath,
} from "@/features/settings/index.ts";

const MembersPage = lazy(() =>
  import("./members-page.tsx").then((module) => ({ default: module.MembersPage })),
);
const SignInPage = lazy(() =>
  import("./sign-in-page.tsx").then((module) => ({ default: module.SignInPage })),
);
const HostsPage = lazy(() =>
  import("./hosts-page.tsx").then((module) => ({ default: module.HostsPage })),
);
const PolicyPage = lazy(() =>
  import("./policy-page.tsx").then((module) => ({ default: module.PolicyPage })),
);
const RegistryPage = lazy(() =>
  import("./registry-page.tsx").then((module) => ({ default: module.RegistryPage })),
);
const AuditPage = lazy(() =>
  import("./audit-page.tsx").then((module) => ({ default: module.AuditPage })),
);

export type OrganizationPage = "members" | "sign-in" | "hosts" | "policy" | "registry" | "audit";

const pages: Record<
  OrganizationPage,
  { title: string; path: SettingsPath; body: (org: AceOrgSpace) => ReactNode }
> = {
  members: {
    title: "Members",
    path: "/settings/organization",
    body: (org) => <MembersPage org={org} />,
  },
  "sign-in": {
    title: "Sign-in",
    path: "/settings/organization/sign-in",
    body: (org) => <SignInPage org={org} />,
  },
  hosts: {
    title: "Hosts",
    path: "/settings/organization/hosts",
    body: (org) => <HostsPage org={org} />,
  },
  policy: {
    title: "Policy",
    path: "/settings/organization/policy",
    body: (org) => <PolicyPage org={org} />,
  },
  registry: {
    title: "Registry",
    path: "/settings/organization/registry",
    body: (org) => <RegistryPage org={org} />,
  },
  audit: {
    title: "Audit log",
    path: "/settings/organization/audit",
    body: (org) => <AuditPage org={org} />,
  },
};

/** One line in place of a page the window can't show, in the page's own card. */
function Instead(props: { children: ReactNode }) {
  return (
    <SettingCard>
      <SettingNote>{props.children}</SettingNote>
    </SettingCard>
  );
}

/**
 * The organization asked for a new sign-in (`org_sign_in_required`, ADR 0206 §1.4): its
 * sign-in policy (SSO, MFA) wants one this session didn't use. The same account signs in again.
 */
function SignInAgain(props: { org: AceOrgSpace }) {
  const store = useAceAccountStore();
  const { refresh } = useSpace();
  const [busy, setBusy] = useState(false);
  return (
    <SettingCard className="mb-8">
      <SettingRow
        title={`${props.org.name} asks you to sign in again`}
        description="Its sign-in policy needs a sign-in this session didn't use. You stay signed in to your own account meanwhile."
        inline
      >
        <Button
          size="sm"
          variant="primary"
          disabled={busy || !store}
          onClick={() => {
            if (!store) return;
            setBusy(true);
            void store
              .signInToOrg(props.org.id, (address) => openExternalWhenReady(address))
              .then((done) => (done ? refresh() : undefined))
              .finally(() => setBusy(false));
          }}
        >
          {busy ? "Finishing in your browser…" : "Sign in"}
        </Button>
      </SettingRow>
    </SettingCard>
  );
}

/**
 * Settings › Organization (ADR 0206 §2.7), in the window's organization's space only. A page
 * whose role isn't the person's says so and shows nothing of the organization's settings.
 */
export function OrganizationSettingsScreen(props: { page: OrganizationPage }) {
  const page = pages[props.page];
  const { shown, calls, signInNeeded } = useSpace();
  const org = shown?.org;
  const needs = organizationPageNeeds(page.path);
  let body: ReactNode;
  if (!calls) body = <Instead>Sign in to your ace account to see your organizations.</Instead>;
  else if (shown === undefined) body = null;
  else if (!org)
    body = <Instead>Switch to an organization from your account menu to see its settings.</Instead>;
  else if (needs && !orgAllows(org.role, needs))
    body = <Instead>Only your organization's admins see this page.</Instead>;
  else
    body = (
      <>
        {signInNeeded === org.id && <SignInAgain org={org} />}
        <Suspense fallback={null}>{page.body(org)}</Suspense>
      </>
    );
  return (
    <SettingsBody page={page.title} lede={org?.name}>
      {body}
    </SettingsBody>
  );
}
