import Foundation
import Observation

/// One paired computer's live runtime. Each has its own JavaScriptCore VM, socket, outbox
/// database and Keychain key (see `ClientRuntime`, `HostServices.connection`).
final class MachineSession: Identifiable {
    let hostId: String
    let client: ClientModel
    var id: String { hostId }
    init(hostId: String, client: ClientModel) { self.hostId = hostId; self.client = client }
}

/// The inbox across every paired machine: which runtime owns a row, what a machine is called and
/// when this phone last saw it. A row, an action and an opened thread always route to the
/// runtime of the machine the row came from; one machine's trouble never touches another's rows.
@MainActor @Observable final class MachineInbox {
    private(set) var sessions: [MachineSession] = []
    private(set) var names: [String: String] = [:]
    private var seen: [String: Double]
    /// Each machine's mark as last seen, so an offline machine's rows keep it.
    private var glyphs: [String: String]
    @ObservationIgnored private let defaults: UserDefaults
    @ObservationIgnored private let now: () -> Double
    @ObservationIgnored private var memo: (inputs: [(String, InboxLayout)], merged: MergedInbox)?
    @ObservationIgnored private var projectCache = ProjectChoiceCache()

    init(defaults: UserDefaults = .standard, now: @escaping () -> Double) {
        self.defaults = defaults; self.now = now
        seen = defaults.dictionary(forKey: Self.seenKey) as? [String: Double] ?? [:]
        glyphs = defaults.dictionary(forKey: Self.glyphsKey) as? [String: String] ?? [:]
    }

    /// The projects search can be filtered by, every machine's, by name. Built from the rows
    /// only when threads join or leave a machine's list, never on a row's own change, so a busy
    /// inbox doesn't rescan and sort every row on each redraw.
    func projectChoices() -> [ProjectChoice] {
        let membership = sessions.map { session in
            ([session.hostId] + session.client.inboxLayout.sections.flatMap(\.ids)).joined(separator: "\u{0}")
        }
        return projectCache.choices(for: membership + [showsMachineNames ? "named" : ""]) {
            var seen = Set<String>()
            return sessions.flatMap { session in
                session.client.inbox.values.compactMap { row -> ProjectChoice? in
                    guard let workspace = row.workspaceId, row.chat != true else { return nil }
                    let id = "\(session.hostId)/\(workspace)"
                    guard seen.insert(id).inserted else { return nil }
                    return ProjectChoice(id: id, name: showsMachineNames ? "\(row.project) · \(name(session.hostId))" : row.project)
                }
            }.sorted { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending }
        }
    }

    /// The phone's clock (ms), as the inbox was given it.
    func clock() -> Double { now() }

    /// Machine names show on rows only when there is more than one machine to tell apart.
    var showsMachineNames: Bool { sessions.count > 1 }
    func client(_ hostId: String) -> ClientModel? { sessions.first { $0.hostId == hostId }?.client }
    func name(_ hostId: String) -> String { names[hostId] ?? hostId }
    /// A row's machine mark: only when there is more than one machine to tell apart.
    func mark(_ hostId: String) -> MachineMark? {
        guard showsMachineNames else { return nil }
        let glyph = client(hostId)?.machineGlyph ?? glyphs[hostId].flatMap(AceIcon.Name.init(rawValue:)) ?? .laptop
        return MachineMark(name: name(hostId), glyph: glyph)
    }
    /// A row's project mark, from the machine the row came from.
    func projectLook(_ key: InboxKey, workspace: String?) -> ProjectMarkLook? {
        workspace.flatMap { client(key.machineId)?.projectLooks[$0] }
    }
    func row(_ key: InboxKey) -> ThreadRow? { client(key.machineId)?.inbox[key.id] }
    func pending(_ key: InboxKey) -> PendingRow? { client(key.machineId)?.pending[key.id] }

    /// Every machine's shared sections, merged by rank. Recomputed only when a layout changed.
    var merged: MergedInbox {
        let inputs = sessions.map { ($0.hostId, $0.client.inboxLayout) }
        if let memo, memo.inputs.count == inputs.count,
           zip(memo.inputs, inputs).allSatisfy({ $0.0 == $1.0 && $0.1 == $1.1 }) { return memo.merged }
        let merged = MergedInbox.merge(inputs.map { (machineId: $0.0, layout: $0.1) })
        memo = (inputs, merged)
        return merged
    }
    /// The machines' Sort threads setting, as the menu shows it: the first machine in `scope`
    /// (one machine's id, or empty for all) that has said. Each runtime orders its own sections.
    func sortBy(in scope: String) -> String? {
        sessions.lazy.filter { scope.isEmpty || $0.hostId == scope }.compactMap { $0.client.inboxLayout.sortBy }.first
    }
    /// The sort choices, worded by the shared rules.
    var sortChoices: [InboxLayout.SortOption] {
        sessions.lazy.compactMap { $0.client.inboxLayout.sorts }.first { !$0.isEmpty } ?? []
    }
    /// Saves `sortBy` as every machine this phone can act on sorts its threads, so one inbox
    /// reads in one order and the web follows it too. Each runtime regroups once its machine
    /// confirms; a machine that refuses keeps its own order and says why.
    func setSort(_ sortBy: String) async {
        for session in sessions where session.client.canOperate && session.client.connection == "ready"
            && session.client.inboxLayout.sortBy != sortBy {
            let client = session.client
            let saved = try? await client.service(
                ["type": "settings.set", "key": "threads.sortBy", "value": sortBy, "layer": ["kind": "global"]],
                as: SortSaved.self)
            if saved?.ok != true { client.error = "Couldn't change how threads are sorted." }
        }
    }
    private struct SortSaved: Decodable { let ok: Bool }
    var allReady: Bool { !sessions.isEmpty && sessions.allSatisfy { $0.client.connection == "ready" } }
    var anyLoaded: Bool { sessions.contains { $0.client.inboxLoaded } }

    func attach(_ hostId: String, name: String, client: ClientModel) {
        names[hostId] = name
        if let index = sessions.firstIndex(where: { $0.hostId == hostId }) { sessions[index] = MachineSession(hostId: hostId, client: client) }
        else { sessions.append(MachineSession(hostId: hostId, client: client)) }
    }
    @discardableResult func detach(_ hostId: String) -> ClientModel? {
        guard let index = sessions.firstIndex(where: { $0.hostId == hostId }) else { return nil }
        names[hostId] = nil
        forget(hostId)
        return sessions.remove(at: index).client
    }
    func rename(_ hostId: String, to name: String) { names[hostId] = name }

    /// When this phone last saw the machine (epoch ms): now while connected, else the bridge's
    /// drop time or what an earlier launch recorded.
    func lastSeen(_ hostId: String) -> Double? {
        guard let client = client(hostId) else { return seen[hostId] }
        if client.connection == "ready" { return now() }
        return [seen[hostId], client.machineStatus?.seenAt].compactMap { $0 }.max()
    }
    /// Persist last-seen times and machine marks, such as when the app leaves the foreground.
    func recordSeen() {
        for session in sessions {
            if let value = lastSeen(session.hostId) { seen[session.hostId] = value }
            if let glyph = session.client.machineGlyph { glyphs[session.hostId] = glyph.rawValue }
        }
        defaults.set(seen, forKey: Self.seenKey)
        defaults.set(glyphs, forKey: Self.glyphsKey)
    }
    private func forget(_ hostId: String) {
        seen[hostId] = nil
        glyphs[hostId] = nil
        defaults.set(seen, forKey: Self.seenKey)
        defaults.set(glyphs, forKey: Self.glyphsKey)
    }
    private static let seenKey = "ace.machines.lastSeen"
    private static let glyphsKey = "ace.machines.marks"
}

/// A project search can filter by: one machine's project ("machine/workspace") and its name.
struct ProjectChoice: Equatable, Sendable { let id: String; let name: String }

/// Keeps the project choices until the list they were read from changes.
struct ProjectChoiceCache {
    private var key: [String]?
    private var kept: [ProjectChoice] = []
    mutating func choices(for key: [String], build: () -> [ProjectChoice]) -> [ProjectChoice] {
        if key != self.key { kept = build(); self.key = key }
        return kept
    }
}
