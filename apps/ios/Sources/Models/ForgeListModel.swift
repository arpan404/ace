import Foundation
import Observation

/// One Pull requests or Issues list on one machine: the bridge's last answer, kept on screen
/// (dimmed) while a changed filter reads, and "Show more" asking for one more screenful. A
/// request that lands after a newer one started is dropped.
@MainActor @Observable final class ForgeListModel<List: Decodable & Sendable & Equatable> {
    private(set) var list: List?
    /// The machine and project the rows on screen belong to: a row opens there, never in a
    /// newly chosen project whose rows haven't arrived yet.
    private(set) var scope: ForgeListScope?
    private(set) var loading = false
    /// The last read failed, in the web's words; the previous rows stay.
    private(set) var failure: String?
    /// The rows on screen answer an older filter than the one being read.
    private(set) var stale = false
    private(set) var screens = 1
    @ObservationIgnored private var key = ""
    @ObservationIgnored private var asking: ForgeListScope?
    @ObservationIgnored private var generation = 0

    /// Starts on the list this phone last saw for `key`, so the page opens on its rows.
    init(list: List? = nil, key: String = "", scope: ForgeListScope? = nil) {
        self.list = list; self.key = key; asking = scope
        if list != nil { self.scope = scope }
    }

    /// Reads the list for `key` (machine, project, filters, query) in `scope`. A new key starts
    /// again at one screenful, on its `kept` rows when the phone has them, else dimming the old
    /// ones; the same key reads again (pull to refresh with `fresh`).
    func load(_ key: String, scope: ForgeListScope, fresh: Bool = false, kept: List? = nil,
              read: @escaping (_ screens: Int, _ fresh: Bool) async throws -> List) async {
        asking = scope
        if key != self.key {
            self.key = key; screens = 1; failure = nil
            if let kept { list = kept; self.scope = scope; stale = false } else { stale = list != nil }
        }
        await run(fresh: fresh, read: read)
    }
    /// One more screenful of the same list.
    func more(read: @escaping (_ screens: Int, _ fresh: Bool) async throws -> List) async {
        guard !loading else { return }
        screens += 1
        await run(fresh: false, read: read)
    }
    func reset() { list = nil; scope = nil; asking = nil; failure = nil; stale = false; screens = 1; key = ""; generation += 1; loading = false }

    private func run(fresh: Bool, read: (_ screens: Int, _ fresh: Bool) async throws -> List) async {
        generation += 1
        let mine = generation
        let reading = asking
        loading = true
        defer { if mine == generation { loading = false } }
        do {
            let next = try await read(screens, fresh)
            guard mine == generation else { return }
            list = next; scope = reading; failure = nil; stale = false
        } catch is CancellationError {
            return
        } catch {
            guard mine == generation else { return }
            failure = error.localizedDescription
            stale = false
        }
    }
}

/// Where a forge list was read: its rows open pages and threads there.
struct ForgeListScope: Equatable, Sendable {
    let machineId: String
    let project: String
}

extension ClientModel {
    /// The machine's registered projects, for the lists' project chip. Kept by the bridge, like
    /// the lists and pages below, so each opens on its last answer (`bridge/read-policy.ts`).
    static let forgeProjectsRead: [String: Any] = ["type": "forge.projects"]
    func forgeProjects() async throws -> [ForgeProject] {
        try await read(Self.forgeProjectsRead, as: ForgeProjects.self).projects
    }
    static func forgePullsRead(project: String, filter: PullsFilter, query: String, screens: Int = 1, fresh: Bool = false) -> [String: Any] {
        ["type": "forge.pulls", "project": project, "search": filter.json(query: query), "screens": screens, "fresh": fresh]
    }
    static func forgeIssuesRead(project: String, filter: IssuesFilter, query: String, screens: Int = 1, fresh: Bool = false) -> [String: Any] {
        ["type": "forge.issues", "project": project, "search": filter.json(query: query), "screens": screens, "fresh": fresh]
    }
    static func forgePullRead(project: String, number: Int, method: String) -> [String: Any] {
        ["type": "forge.pull", "project": project, "number": number, "method": method]
    }
    static func forgeIssueRead(project: String, number: Int) -> [String: Any] {
        ["type": "forge.issue", "project": project, "number": number]
    }
    func forgePulls(project: String, filter: PullsFilter, query: String, screens: Int, fresh: Bool) async throws -> ForgePullList {
        try await read(Self.forgePullsRead(project: project, filter: filter, query: query, screens: screens, fresh: fresh), as: ForgePullList.self)
    }
    func forgeIssues(project: String, filter: IssuesFilter, query: String, screens: Int, fresh: Bool) async throws -> ForgeIssueList {
        try await read(Self.forgeIssuesRead(project: project, filter: filter, query: query, screens: screens, fresh: fresh), as: ForgeIssueList.self)
    }
    func forgePull(project: String, number: Int, method: String) async throws -> ForgePullPage {
        try await read(Self.forgePullRead(project: project, number: number, method: method), as: ForgePullPage.self)
    }
    func forgeIssue(project: String, number: Int) async throws -> ForgeIssuePage {
        try await read(Self.forgeIssueRead(project: project, number: number), as: ForgeIssuePage.self)
    }
    /// Merge, or switch auto-merge, at the head and method the person asked against.
    func forgeWrite(_ target: ForgeWriteTarget) async -> ForgeWrite {
        guard canOperate else { return ForgeWrite(ok: false, message: "View only. Merge on your computer, or pair this phone with View and act.") }
        do { return try await service(target.payload, as: ForgeWrite.self) }
        catch { return ForgeWrite(ok: false, message: error.localizedDescription) }
    }
}
