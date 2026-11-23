import Foundation

/// A member as an organization's admins see them (`GET /v1/orgs/{org}/members`).
struct AceOrgPerson: Decodable, Sendable, Equatable, Identifiable {
    let account: String
    var email: String? = nil
    var name: String? = nil
    let role: String
    /// `active`, or `pending` before they join; one WorkOS adds later is kept as given.
    let status: String
    /// The organization's identity provider sets this membership, so ace can't change it.
    let directoryManaged: Bool
    var id: String { account }
}
/// An invitation WorkOS mailed (`GET /v1/orgs/{org}/invitations`).
struct AceOrgInvite: Decodable, Sendable, Equatable, Identifiable {
    let id: String
    let email: String
    var role: String? = nil
    let state: String
}
/// One stored policy version (`GET /v1/orgs/{org}/policy`): its text and number.
struct AceOrgPolicyVersion: Decodable, Sendable, Equatable {
    let version: Int
    let body: String
}
/// A setup task the Admin Portal does (`POST /v1/orgs/{org}/portal {intent}`).
enum AceOrgPortalIntent: String, Sendable {
    case domainVerification = "domain_verification", sso, dsync, auditLogs = "audit_logs", logStreams = "log_streams"
}

/// An organization's admin routes on the account backend (`packages/client/src/ace-org.ts`), with
/// the person's own session: members and their roles, invitations, Admin Portal links, releasing
/// a host and the policy. WorkOS decides, on the backend, whether the person may.
extension AceAccountAPI {
    func people(token: String, org: String) async throws(AceOrgError) -> [AceOrgPerson] {
        struct List: Decodable { let members: [AceOrgPerson] }
        let list: List = try await orgCall(try Self.orgPath(org, "members"), method: "GET", token: token)
        return list.members
    }
    func changeRole(token: String, org: String, account: String, role: String) async throws(AceOrgError) {
        let body = try? JSONEncoder().encode(["role": role])
        let _: Ignored = try await orgCall(try Self.orgPath(org, "members", account), method: "PATCH", token: token, body: body)
    }
    /// Remove: deletes the membership only. The person keeps their account and machines.
    func removeMember(token: String, org: String, account: String) async throws(AceOrgError) {
        let _: Ignored = try await orgCall(try Self.orgPath(org, "members", account), method: "DELETE", token: token)
    }
    func invitations(token: String, org: String) async throws(AceOrgError) -> [AceOrgInvite] {
        struct List: Decodable { let invitations: [AceOrgInvite] }
        let list: List = try await orgCall(try Self.orgPath(org, "invitations"), method: "GET", token: token)
        return list.invitations
    }
    /// WorkOS sends the mail; nobody joins until they choose to.
    func invite(token: String, org: String, email: String, role: String) async throws(AceOrgError) {
        let body = try? JSONEncoder().encode(["email": email, "role": role])
        let _: Ignored = try await orgCall(try Self.orgPath(org, "invitations"), method: "POST", token: token, body: body)
    }
    func revokeInvitation(token: String, org: String, id: String) async throws(AceOrgError) {
        let _: Ignored = try await orgCall(try Self.orgPath(org, "invitations", id), method: "DELETE", token: token)
    }
    /// A five-minute Admin Portal link, tied to the admin who asked for it.
    func portal(token: String, org: String, intent: AceOrgPortalIntent) async throws(AceOrgError) -> URL {
        struct Link: Decodable { let link: String }
        let body = try? JSONEncoder().encode(["intent": intent.rawValue])
        let link: Link = try await orgCall(try Self.orgPath(org, "portal"), method: "POST", token: token, body: body)
        guard let url = URL(string: link.link), url.scheme == "https" else { throw .refused("invalid") }
        return url
    }
    /// An owner releases a host: its credentials from this enrollment stop working.
    func releaseHost(token: String, org: String, hostId: String) async throws(AceOrgError) {
        let _: Ignored = try await orgCall(try Self.orgPath(org, "hosts", hostId), method: "DELETE", token: token)
    }
    func policy(token: String, org: String) async throws(AceOrgError) -> AceOrgPolicyVersion {
        try await orgCall(try Self.orgPath(org, "policy"), method: "GET", token: token)
    }
    /// Saves the next version from the bridge's body (`{"policy": …}`); `policy_changed` when
    /// another admin saved one first.
    func setPolicy(token: String, org: String, body: Data) async throws(AceOrgError) -> AceOrgPolicyVersion {
        try await orgCall(try Self.orgPath(org, "policy"), method: "PUT", token: token, body: body)
    }

    /// `orgs/{org}/{part}[/{item}]`, the organization's id checked and the item escaped.
    static func orgPath(_ org: String, _ part: String, _ item: String? = nil) throws(AceOrgError) -> String {
        guard isOrgId(org) else { throw .refused("invalid") }
        guard let item else { return "orgs/\(org)/\(part)" }
        guard !item.isEmpty, let segment = item.addingPercentEncoding(withAllowedCharacters: unreserved) else {
            throw .refused("invalid")
        }
        return "orgs/\(org)/\(part)/\(segment)"
    }
}

/// RFC 3986's unreserved characters: account and invitation ids (`user_01…`) pass unescaped.
private let unreserved = CharacterSet(charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~")
