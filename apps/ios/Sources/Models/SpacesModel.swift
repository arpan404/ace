import Foundation
import Observation

/// The phone's space (ADR 0206 §1.4, §1.5): the person's organizations from the account backend,
/// each one's hosts, and which space the lists show. The choice is kept per account, so a relaunch
/// keeps it. Switching closes no connection and deletes nothing; leaving an organization takes its
/// space off the list and its hosts out of reach, and every thread and draft stays on the phone.
/// The rules themselves are `Spaces`.
@MainActor @Observable final class SpacesModel {
    /// The person's organizations; nil while signed out or while the list is on its way.
    private(set) var spaces: [AceOrgSpace]?
    /// Signed in to an account backend, so spaces apply.
    private(set) var signedIn = false
    /// The list couldn't be read: only Personal shows, as on the web.
    private(set) var failed = false
    /// Each organization's hosts' relay ids, as far as they are known.
    private(set) var hostsOf: [String: Set<String>] = [:]
    /// Each organization's members, for a shared bot's approvers' names.
    private(set) var members: [String: [AceOrgMember]] = [:]
    private(set) var chosen = Spaces.personal
    private(set) var busy = false
    /// The account's id, for a shared bot's requests ("You or Dana can answer").
    private(set) var accountId: String?

    @ObservationIgnored private var api: AceAccountAPI?
    @ObservationIgnored private var token: String?
    @ObservationIgnored private var hosts: [String: [AceMachine]] = [:]
    @ObservationIgnored private let defaults: UserDefaults
    /// An inbox host id's relay host id: an account machine's own, a paired one's account id.
    @ObservationIgnored var relayId: (String) -> String? = { _ in nil }
    /// The organizations' hosts changed: the machines model connects to them as account machines.
    @ObservationIgnored var hostsChanged: (([AceMachine]) async -> Void)?

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
    }

    /// The space the lists show; nil only while a chosen organization is being checked.
    var shown: Spaces.Shown? {
        signedIn ? Spaces.shown(chosen: chosen, spaces: failed ? [] : spaces) : .personal
    }
    /// The organizations Personal leaves out; nil while the list is on its way.
    private var orgs: [String]? { !signedIn || failed ? [] : spaces?.map(\.id) }

    /// Whether the machine with this inbox host id shows in the space shown.
    func contains(machine hostId: String) -> Bool {
        Spaces.contains(relayId(hostId), space: shown, hostsOf: hostsOf, orgs: orgs)
    }
    /// The organization a machine hosts for, if any.
    func org(ofMachine hostId: String?) -> AceOrgSpace? {
        Spaces.org(of: hostId.flatMap(relayId), spaces: spaces ?? [], hostsOf: hostsOf)
    }
    /// A notice's space label for the machine it came from (`Spaces.noticeLabel`).
    func noticeLabel(machine hostId: String?) -> String? {
        Spaces.noticeLabel(org: org(ofMachine: hostId), spaces: spaces)
    }
    /// Switch to the space a machine belongs to, as opening a notice from it does.
    func enter(machine hostId: String) {
        let id = org(ofMachine: hostId)?.id ?? Spaces.personal
        if shown?.id != id { choose(id) }
    }
    /// Why New thread can't start in the space shown, or nil (`Spaces.startBlock`).
    func startBlock(reachable: Int) -> String? {
        Spaces.startBlock(shown, hostsOf: hostsOf, reachable: reachable)
    }

    func choose(_ id: String) {
        chosen = id
        if let key = choiceKey { defaults.set(id, forKey: key) }
    }

    /// Follow the account: signed in, read the spaces and their hosts; signed out, Personal only.
    func follow(origin: URL?, token: String?, account: String?) async {
        guard let origin, let token, let account else {
            api = nil; self.token = nil; accountId = nil
            signedIn = false; spaces = nil; failed = false; hostsOf = [:]; members = [:]; hosts = [:]
            chosen = Spaces.personal
            await hostsChanged?([])
            return
        }
        let changed = self.token != token || accountId != account
        if changed {
            api = AceAccountAPI(origin: origin, allowLoopback: Self.loopback(origin))
            self.token = token; accountId = account; signedIn = true
            spaces = nil; failed = false; hostsOf = [:]; members = [:]; hosts = [:]
            chosen = choiceKey.flatMap { defaults.string(forKey: $0) } ?? Spaces.personal
        }
        await reload()
    }

    /// The list and every organization's hosts again, as after creating, leaving or a pull.
    func reload() async {
        guard let api, let token else { return }
        do {
            let listed = try await api.spaces(token: token)
            spaces = listed; failed = false
            forgetGone(listed)
            await withTaskGroup(of: Void.self) { group in
                for space in listed {
                    group.addTask { await self.readOrg(space.id, api: api, token: token) }
                }
            }
            await hostsChanged?(hosts.values.flatMap { $0 })
        } catch .signedOut {
            spaces = []; failed = true
        } catch {
            // Kept as it was: a list already read stays, and a first read shows Personal only.
            if spaces == nil { failed = true }
        }
    }

    /// A new organization, owned by the person, and the phone switched to it. Nil when done.
    func create(name: String) async -> String? {
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let api, let token, !trimmed.isEmpty, !busy else { return nil }
        busy = true
        defer { busy = false }
        do {
            let made = try await api.createOrg(token: token, name: String(trimmed.prefix(128)))
            spaces = (spaces ?? []) + [made]
            hostsOf[made.id] = []
            choose(made.id)
            await reload()
            return nil
        } catch {
            return Self.createFailure(error)
        }
    }

    /// Leave an organization: its space goes from the list and its hosts from reach. Nothing on
    /// the phone is deleted, so its threads come back if the person joins again. Nil when done.
    func leave(_ org: String) async -> String? {
        guard let api, let token, let accountId, !busy else { return nil }
        busy = true
        defer { busy = false }
        do {
            try await api.leave(token: token, org: org, account: accountId)
        } catch .refused("last_owner") {
            return "You're its only owner. Make someone else an owner on desktop or the web first."
        } catch .refused("directory_managed") {
            return "Your organization's directory manages your membership, so you can't leave here."
        } catch {
            return "Couldn't leave. Check your connection and try again."
        }
        let remaining = (spaces ?? []).filter { $0.id != org }
        spaces = remaining
        forgetGone(remaining)
        await hostsChanged?(hosts.values.flatMap { $0 })
        return nil
    }

    private func readOrg(_ org: String, api: AceAccountAPI, token: String) async {
        if let listed = try? await api.hosts(token: token, org: org) {
            hosts[org] = listed
            hostsOf[org] = Set(listed.map(\.hostId))
        }
        if let listed = try? await api.members(token: token, org: org) { members[org] = listed }
    }

    /// An organization the list no longer has: its hosts and members go, and a choice of it.
    private func forgetGone(_ listed: [AceOrgSpace]) {
        let kept = Set(listed.map(\.id))
        hostsOf = hostsOf.filter { kept.contains($0.key) }
        hosts = hosts.filter { kept.contains($0.key) }
        members = members.filter { kept.contains($0.key) }
        if chosen != Spaces.personal, !kept.contains(chosen) { choose(Spaces.personal) }
    }

    private var choiceKey: String? {
        guard let api, let accountId else { return nil }
        return "ace.space:\(api.origin.absoluteString):\(accountId)"
    }

    private static func loopback(_ origin: URL) -> Bool {
        ["localhost", "127.0.0.1", "[::1]", "::1"].contains(origin.host ?? "")
    }

    private static func createFailure(_ error: AceOrgError) -> String {
        switch error {
        case .refused("email_unverified"): "Verify your email first, then create an organization."
        case .signedOut: "Your session ended. Sign in again."
        default: "Couldn't create the organization. Try again."
        }
    }
}

extension SpacesModel {
    /// Puts the inbox, its notices and the machine list in step with the space: the lists show
    /// the space's machines, a notice or link from another space switches to it first, and
    /// alerts carry their space's name. `machines` is nil for the fixture, whose machines are
    /// named by their own host ids.
    func bind(_ inbox: MachineInbox, machines: MachinesModel?, desk: AlertDesk?) {
        if let machines {
            relayId = { [weak machines] hostId in
                machines?.entry(hostId).flatMap { $0.isAccountMachine ? $0.hostId : $0.accountHostId }
            }
            hostsChanged = { [weak machines] hosts in await machines?.followOrgHosts(hosts) }
        } else {
            relayId = { $0 }
        }
        inbox.inSpace = { [weak self] hostId in self?.contains(machine: hostId) ?? true }
        inbox.enterSpace = { [weak self] hostId in self?.enter(machine: hostId) }
        inbox.spaceBlock = { [weak self, weak inbox] in self?.startBlock(reachable: inbox?.sessions.count ?? 0) }
        desk?.spaceLabel = { [weak self] hostId in self?.noticeLabel(machine: hostId) }
    }
}
