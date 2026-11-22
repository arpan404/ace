import Foundation
import Observation

/// What a role may do in ace (ADR 0206 §1.2), as `@ace/account-grant/org-roles` decides it on the
/// backend and the daemon. The phone only uses it to choose what to show; the backend still
/// decides. A role ace doesn't know acts as `member`.
enum OrgRoles {
    enum Permission { case membersManage, policySet, hostsManage, registryPublish, auditRead, ssoManage, owners }

    static func allows(_ role: String, _ permission: Permission) -> Bool {
        switch role {
        case "owner": true
        case "admin": permission != .owners
        case "billing": permission == .auditRead
        default: false
        }
    }
    /// Settings › Organization shows for the shown space's admins and owners only.
    static func isAdmin(_ role: String) -> Bool { allows(role, .membersManage) }
    /// The roles a person may give: owners give `owner` too.
    static func assignable(by role: String) -> [String] {
        allows(role, .owners) ? ["member", "admin", "owner"] : ["member", "admin"]
    }
}

/// One sentence for an org call the backend refused, as web's `orgFailure` says it
/// (`apps/web/src/features/ace-org/org-copy.ts`).
enum OrgRefusal {
    static func sentence(_ error: AceOrgError) -> String {
        switch error {
        case .signedOut: return "Your ace session ended. Sign in again."
        case .unavailable: return "Couldn't reach your ace account. Try again."
        case .refused(let code): return said[code] ?? "Couldn't reach your ace account. Try again."
        }
    }
    private static let said: [String: String] = [
        "forbidden": "Your role in this organization doesn't allow that.",
        "not_member": "You're no longer a member of this organization.",
        "org_sign_in_required": "This organization asks you to sign in again. Sign in on desktop or the web.",
        "last_owner": "An organization always keeps one owner. Make someone else an owner first.",
        "directory_managed": "Set by your identity provider, so it can't be changed here.",
        "invitation_refused": "Couldn't invite that address. Check it, or it may already be invited.",
        "policy_changed": "Another admin saved the policy first. Look it over and save again.",
        "not_found": "That's no longer there.",
        "busy": "Someone else is changing this organization. Try again in a moment.",
    ]
}

/// One organization's admin pages on the phone (ADR 0206 amendment 4): its members and
/// invitations, its hosts, Admin Portal links and its policy, read and changed on the account
/// backend with the person's own session. Every change answers nil when done or the sentence for
/// why not, and reads the list again so it shows what the backend now holds.
@MainActor @Observable final class OrganizationAdmin {
    let org: AceOrgSpace
    let accountId: String?
    private(set) var members: [AceOrgPerson]?
    private(set) var invitations: [AceOrgInvite]?
    private(set) var hosts: [AceMachine]?
    /// Why the last read failed, shown in place of its list.
    private(set) var problem: String?
    private(set) var busy = false

    @ObservationIgnored private let api: AceAccountAPI
    @ObservationIgnored private let token: String

    init(org: AceOrgSpace, api: AceAccountAPI, token: String, accountId: String?) {
        self.org = org
        self.api = api
        self.token = token
        self.accountId = accountId
    }

    func allows(_ permission: OrgRoles.Permission) -> Bool { OrgRoles.allows(org.role, permission) }

    func readMembers() async {
        do {
            async let people = api.people(token: token, org: org.id)
            async let invited = api.invitations(token: token, org: org.id)
            members = try await people
            invitations = try await invited.filter { $0.state == "pending" }
            problem = nil
        } catch let error as AceOrgError {
            problem = OrgRefusal.sentence(error)
        } catch {
            problem = OrgRefusal.sentence(.unavailable)
        }
    }

    func readHosts() async {
        do { hosts = try await api.hosts(token: token, org: org.id); problem = nil }
        catch { problem = OrgRefusal.sentence(error) }
    }

    /// Whether the person may change this member's role or remove them: not themself, not a
    /// membership the identity provider sets, and an owner only by another owner.
    func canChange(_ member: AceOrgPerson) -> Bool {
        allows(.membersManage) && member.account != accountId && !member.directoryManaged
            && (member.role != "owner" || allows(.owners))
    }

    func changeRole(_ member: AceOrgPerson, to role: String) async -> String? {
        await change { try await self.api.changeRole(token: self.token, org: self.org.id, account: member.account, role: role) }
            then: { await self.readMembers() }
    }
    func remove(_ member: AceOrgPerson) async -> String? {
        await change { try await self.api.removeMember(token: self.token, org: self.org.id, account: member.account) }
            then: { await self.readMembers() }
    }
    func invite(email: String, role: String) async -> String? {
        let address = email.trimmingCharacters(in: .whitespacesAndNewlines)
        guard address.range(of: "^[^\\s@]+@[^\\s@]+$", options: .regularExpression) != nil else {
            return "That doesn't look like an email address."
        }
        return await change { try await self.api.invite(token: self.token, org: self.org.id, email: address, role: role) }
            then: { await self.readMembers() }
    }
    func revoke(_ invitation: AceOrgInvite) async -> String? {
        await change { try await self.api.revokeInvitation(token: self.token, org: self.org.id, id: invitation.id) }
            then: { await self.readMembers() }
    }
    func release(_ host: AceMachine) async -> String? {
        await change { try await self.api.releaseHost(token: self.token, org: self.org.id, hostId: host.hostId) }
            then: { await self.readHosts() }
    }

    /// A five-minute Admin Portal link for one setup task, or the sentence for why not.
    func portal(_ intent: AceOrgPortalIntent) async -> Result<URL, PortalRefused> {
        do { return .success(try await api.portal(token: token, org: org.id, intent: intent)) }
        catch { return .failure(PortalRefused(sentence: OrgRefusal.sentence(error))) }
    }
    struct PortalRefused: Error { let sentence: String }

    func policy() async -> Result<AceOrgPolicyVersion, PortalRefused> {
        do { return .success(try await api.policy(token: token, org: org.id)) }
        catch { return .failure(PortalRefused(sentence: OrgRefusal.sentence(error))) }
    }
    func savePolicy(body: Data) async -> Result<AceOrgPolicyVersion, PortalRefused> {
        guard !busy else { return .failure(PortalRefused(sentence: "Still saving.")) }
        busy = true
        defer { busy = false }
        do { return .success(try await api.setPolicy(token: token, org: org.id, body: body)) }
        catch { return .failure(PortalRefused(sentence: OrgRefusal.sentence(error))) }
    }

    private func change(_ run: @escaping () async throws(AceOrgError) -> Void, then reread: () async -> Void) async -> String? {
        guard !busy else { return nil }
        busy = true
        defer { busy = false }
        do { try await run() } catch { return OrgRefusal.sentence(error) }
        await reread()
        return nil
    }
}
