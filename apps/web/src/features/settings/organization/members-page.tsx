import { orgAllows, orgRole } from "@ace/client/ace-org";
import type { AceOrgAssignableRole, AceOrgMember, AceOrgSpace } from "@ace/protocol/ace-org";
import { useState } from "react";
import { ConfirmDialog, type Confirming } from "@/components/confirm-dialog.tsx";
import {
  SettingList,
  SettingListItem,
  SettingNote,
  SettingSection,
} from "@/components/setting-row.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Input } from "@/components/ui/input.tsx";
import { Select, type SelectOption } from "@/components/ui/select.tsx";
import { roleWord, useAceAccount, useSpace } from "@/features/ace-account/index.ts";
import {
  orgFailure,
  useChangeRole,
  useInvite,
  useOrgInvitations,
  useOrgMembers,
  useRemoveMember,
  useRevokeInvitation,
} from "@/features/ace-org/index.ts";

/** The roles a person may give from here: owners give `owner` too (ADR 0206 §1.3). */
function assignable(role: string): SelectOption<AceOrgAssignableRole>[] {
  const roles: AceOrgAssignableRole[] = orgAllows(role, "org:owners")
    ? ["member", "admin", "owner"]
    : ["member", "admin"];
  return roles.map((value) => ({ value, label: roleWord(value) }));
}

const memberName = (member: AceOrgMember) => member.name || member.email || member.account;

/**
 * Settings › Organization › Members (ADR 0206 §2.7): everyone in the organization from its mirror;
 * for admins, roles to change, members to remove and invitations to send or revoke. A role set by
 * the organization's identity provider is read-only here. Remove deletes the membership only: the
 * person keeps their account, their machines and everything on them. Leave is the same for
 * oneself.
 */
export function MembersPage(props: { org: AceOrgSpace }) {
  const { org } = props;
  const self = useAceAccount().session?.account.id;
  const manages = orgAllows(org.role, "members:manage");
  const members = useOrgMembers(org.id);
  const change = useChangeRole(org.id);
  const remove = useRemoveMember(org.id);
  const { refresh } = useSpace();
  const [confirming, setConfirming] = useState<Confirming>();
  const [error, setError] = useState("");
  const failed = (cause: unknown) => setError(orgFailure(cause));
  const rows = members.data ?? [];
  const options = assignable(org.role);
  return (
    <>
      <SettingSection label="Members" anchor="org.members">
        {members.isLoading && <SettingNote>Loading members…</SettingNote>}
        {members.error && <SettingNote role="alert">{orgFailure(members.error)}</SettingNote>}
        {rows.length > 0 && (
          <SettingList aria-label="Members">
            {rows.map((member) => {
              const you = member.account === self;
              const touchesOwner = orgRole(member.role) === "owner";
              const canChange =
                manages &&
                !you &&
                !member.directoryManaged &&
                (!touchesOwner || orgAllows(org.role, "org:owners"));
              const name = memberName(member);
              const current = canChange
                ? options.find((option) => option.value === member.role)
                : undefined;
              return (
                <SettingListItem key={member.account} className="gap-3">
                  <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span className="truncate text-ui font-medium text-foreground">
                      {you ? `${name} (you)` : name}
                    </span>
                    <span className="truncate text-xs text-subtle-foreground">
                      {[
                        member.name && member.email,
                        member.status === "pending" ? "Hasn't joined yet" : undefined,
                        member.directoryManaged ? "Set by your identity provider" : undefined,
                      ]
                        .filter(Boolean)
                        .join(" · ")}
                    </span>
                  </span>
                  {current ? (
                    <Select
                      label={`${name}'s role`}
                      value={current.value}
                      options={options}
                      disabled={change.isPending}
                      onValueChange={(role) => {
                        setError("");
                        change.mutate({ account: member.account, role }, { onError: failed });
                      }}
                    />
                  ) : (
                    <span className="shrink-0 text-ui text-muted-foreground">
                      {roleWord(member.role)}
                    </span>
                  )}
                  {you ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={remove.isPending}
                      onClick={() =>
                        setConfirming({
                          title: `Leave ${org.name}?`,
                          body: `Its hosts and shared bots stay ${org.name}'s. Your own account, machines and everything on them stay as they are.`,
                          confirm: "Leave",
                          run: () => {
                            setError("");
                            remove.mutate(member.account, {
                              onError: failed,
                              onSuccess: () => void refresh(),
                            });
                          },
                        })
                      }
                    >
                      Leave
                    </Button>
                  ) : (
                    canChange && (
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={remove.isPending}
                        onClick={() =>
                          setConfirming({
                            title: `Remove ${name}?`,
                            body: `They lose ${org.name}'s hosts and shared bots. Their own account, machines and data stay theirs, untouched.`,
                            confirm: "Remove",
                            run: () => {
                              setError("");
                              remove.mutate(member.account, { onError: failed });
                            },
                          })
                        }
                      >
                        Remove
                      </Button>
                    )
                  )}
                </SettingListItem>
              );
            })}
          </SettingList>
        )}
        {error && (
          <SettingNote role="alert" className="text-destructive">
            {error}
          </SettingNote>
        )}
      </SettingSection>
      {manages && <Invitations org={org} options={options} />}
      <ConfirmDialog confirming={confirming} onDone={() => setConfirming(undefined)} />
    </>
  );
}

/** Invite by email (WorkOS sends the mail; the invitee chooses to join), and pending invitations. */
function Invitations(props: { org: AceOrgSpace; options: SelectOption<AceOrgAssignableRole>[] }) {
  const { org } = props;
  const invitations = useOrgInvitations(org.id, true);
  const invite = useInvite(org.id);
  const revoke = useRevokeInvitation(org.id);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<AceOrgAssignableRole>("member");
  const [error, setError] = useState("");
  const pending = (invitations.data ?? []).filter((each) => each.state === "pending");
  const address = email.trim();
  return (
    <SettingSection
      label="Invitations"
      anchor="org.invitations"
      note="WorkOS sends the invitation. Nobody joins until they choose to."
    >
      <form
        className="flex min-h-(--setting-row-height) flex-wrap items-center gap-2 py-(--setting-row-y)"
        onSubmit={(event) => {
          event.preventDefault();
          if (!address) return;
          setError("");
          invite.mutate(
            { email: address, role },
            {
              onSuccess: () => setEmail(""),
              onError: (cause) => setError(orgFailure(cause)),
            },
          );
        }}
      >
        <Input
          aria-label="Email address to invite"
          type="email"
          placeholder="name@example.com"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          className="min-w-48 flex-1"
        />
        <Select<AceOrgAssignableRole>
          label="Role to invite as"
          value={role}
          options={props.options}
          onValueChange={setRole}
        />
        <Button type="submit" size="sm" variant="primary" disabled={!address || invite.isPending}>
          {invite.isPending ? "Inviting…" : "Invite"}
        </Button>
      </form>
      {pending.length > 0 && (
        <SettingList aria-label="Pending invitations">
          {pending.map((invitation) => (
            <SettingListItem key={invitation.id} className="gap-3">
              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="truncate text-ui text-foreground">{invitation.email}</span>
                <span className="truncate text-xs text-subtle-foreground">
                  {`${roleWord(invitation.role ?? "member")} · Invited`}
                </span>
              </span>
              <Button
                size="sm"
                variant="ghost"
                disabled={revoke.isPending}
                onClick={() => {
                  setError("");
                  revoke.mutate(invitation.id, { onError: (cause) => setError(orgFailure(cause)) });
                }}
              >
                Revoke
              </Button>
            </SettingListItem>
          ))}
        </SettingList>
      )}
      {error && (
        <SettingNote role="alert" className="text-destructive">
          {error}
        </SettingNote>
      )}
    </SettingSection>
  );
}
