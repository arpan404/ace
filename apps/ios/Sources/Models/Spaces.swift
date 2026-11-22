import Foundation

/// Spaces (ADR 0206 §1.4, §1.5), pure: the person's personal space is their own account, and each
/// organization they are an active member of is another. The phone shows one at a time; switching
/// signs nobody in or out and closes no connection, and leaving an organization only takes its
/// space off the list.
///
/// The rules are `@ace/client/ace-spaces`, which desktop and the web run. They decide across
/// every machine at once, and the phone runs one JavaScript runtime per machine, so this is their
/// copy for the inbox: it is tested against the same table the TypeScript is
/// (`packages/client/src/ace-spaces-cases.json`), so the two can't drift apart.
enum Spaces {
    static let personal = "personal"

    /// The space shown: Personal, or one organization the person belongs to now.
    struct Shown: Equatable, Sendable {
        let id: String
        let org: AceOrgSpace?
        static let personal = Shown(id: Spaces.personal, org: nil)
    }

    /// The space to show for what the phone chose. An organization no longer listed (left or
    /// removed) shows Personal; while the list is still on its way the choice stands, so nothing
    /// of another space is drawn meanwhile (nil).
    static func shown(chosen: String, spaces: [AceOrgSpace]?) -> Shown? {
        if chosen == personal { return .personal }
        guard let spaces else { return nil }
        return spaces.first { $0.id == chosen }.map { Shown(id: $0.id, org: $0) } ?? .personal
    }

    /// A role in words, as the switcher and Members list it; one ace doesn't know is shown as given.
    static func roleWord(_ role: String) -> String {
        switch role {
        case "owner": "Owner"
        case "admin": "Admin"
        case "member": "Member"
        case "billing": "Billing"
        default: role
        }
    }

    /// Whether `relayId`'s machine is in `space` (`machinesInSpace`): an organization's space holds
    /// only its hosts; Personal every machine that isn't a host of one of the person's
    /// organizations. `hostsOf` misses an organization still loading: until its hosts are known,
    /// Personal shows no machine it can't place and that organization's space shows nothing.
    /// `orgs` is nil while the list itself is on its way: Personal then places only machines with
    /// no relay id (paired over the LAN), which are never an organization's host.
    static func contains(_ relayId: String?, space: Shown?, hostsOf: [String: Set<String>], orgs: [String]?) -> Bool {
        guard let space else { return false }
        if space.org != nil { return hostsOf[space.id]?.contains(relayId ?? "") ?? false }
        guard let relayId else { return true }
        guard let orgs, orgs.allSatisfy({ hostsOf[$0] != nil }) else { return false }
        return !orgs.contains { hostsOf[$0]?.contains(relayId) ?? false }
    }

    /// The organization whose hosts include `relayId`; nil for Personal or a LAN machine.
    static func org(of relayId: String?, spaces: [AceOrgSpace], hostsOf: [String: Set<String>]) -> AceOrgSpace? {
        guard let relayId else { return nil }
        return spaces.first { hostsOf[$0.id]?.contains(relayId) ?? false }
    }

    /// A name as its owner: "Acme Robotics'", "Dana's".
    static func possessive(_ name: String) -> String { name.hasSuffix("s") ? "\(name)'" : "\(name)'s" }

    /// Why a new thread can't start in the shown space, or nil when it can (ADR 0206 §2.4): in an
    /// organization's space a thread starts only on one of its machines. `reachable` counts the
    /// space's machines this phone lists.
    static func startBlock(_ space: Shown?, hostsOf: [String: Set<String>], reachable: Int) -> String? {
        guard let space else { return "Loading this organization's machines…" }
        guard let org = space.org else { return nil }
        guard let hosts = hostsOf[org.id] else { return "Loading \(possessive(org.name)) machines…" }
        if hosts.isEmpty { return "\(org.name) has no machines yet." }
        if reachable == 0 { return "None of \(possessive(org.name)) machines are connected to this window." }
        return nil
    }

    /// Admins and owners manage an organization on desktop or the web; the phone has one row for it.
    static func manageLine(_ space: Shown?) -> String? {
        guard let org = space?.org, org.role == "owner" || org.role == "admin" else { return nil }
        return "Manage \(org.name) on desktop or the web"
    }

    /// The space a notice is labelled with; nil while the person has no organization.
    static func noticeLabel(org: AceOrgSpace?, spaces: [AceOrgSpace]?) -> String? {
        guard let spaces, !spaces.isEmpty else { return nil }
        return org?.name ?? "Personal"
    }
}
