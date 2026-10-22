import Foundation
import Observation

/// One Pull requests or Issues list on one machine: the bridge's last answer, kept on screen
/// (dimmed) while a changed filter reads, and "Show more" asking for one more screenful. A
/// request that lands after a newer one started is dropped.
@MainActor @Observable final class ForgeListModel<List: Decodable & Sendable & Equatable> {
    private(set) var list: List?
    private(set) var loading = false
    /// The last read failed, in the web's words; the previous rows stay.
    private(set) var failure: String?
    /// The rows on screen answer an older filter than the one being read.
    private(set) var stale = false
    private(set) var screens = 1
    @ObservationIgnored private var key = ""
    @ObservationIgnored private var generation = 0

    /// Reads the list for `key` (machine, project, filters, query). A new key starts again at
    /// one screenful; the same key reads again (pull to refresh with `fresh`).
    func load(_ key: String, fresh: Bool = false, read: @escaping (_ screens: Int, _ fresh: Bool) async throws -> List) async {
        if key != self.key { self.key = key; screens = 1; stale = list != nil }
        await run(fresh: fresh, read: read)
    }
    /// One more screenful of the same list.
    func more(read: @escaping (_ screens: Int, _ fresh: Bool) async throws -> List) async {
        guard !loading else { return }
        screens += 1
        await run(fresh: false, read: read)
    }
    func reset() { list = nil; failure = nil; stale = false; screens = 1; key = ""; generation += 1; loading = false }

    private func run(fresh: Bool, read: (_ screens: Int, _ fresh: Bool) async throws -> List) async {
        generation += 1
        let mine = generation
        loading = true
        defer { if mine == generation { loading = false } }
        do {
            let next = try await read(screens, fresh)
            guard mine == generation else { return }
            list = next; failure = nil; stale = false
        } catch is CancellationError {
            return
        } catch {
            guard mine == generation else { return }
            failure = error.localizedDescription
            stale = false
        }
    }
}

extension ClientModel {
    /// The machine's registered projects, for the lists' project chip.
    func forgeProjects() async throws -> [ForgeProject] {
        try await service(["type": "forge.projects"], as: ForgeProjects.self).projects
    }
    func forgePulls(project: String, filter: PullsFilter, query: String, screens: Int, fresh: Bool) async throws -> ForgePullList {
        try await service(["type": "forge.pulls", "project": project, "search": filter.json(query: query), "screens": screens, "fresh": fresh], as: ForgePullList.self)
    }
    func forgeIssues(project: String, filter: IssuesFilter, query: String, screens: Int, fresh: Bool) async throws -> ForgeIssueList {
        try await service(["type": "forge.issues", "project": project, "search": filter.json(query: query), "screens": screens, "fresh": fresh], as: ForgeIssueList.self)
    }
    func forgePull(project: String, number: Int, method: String) async throws -> ForgePullPage {
        try await service(["type": "forge.pull", "project": project, "number": number, "method": method], as: ForgePullPage.self)
    }
    func forgeIssue(project: String, number: Int) async throws -> ForgeIssuePage {
        try await service(["type": "forge.issue", "project": project, "number": number], as: ForgeIssuePage.self)
    }
    /// Merge, or switch auto-merge, at the head the page showed. The answer says what happened.
    func forgeWrite(project: String, page: ForgePullPage, kind: String, method: String) async -> ForgeWrite {
        guard canOperate else { return ForgeWrite(ok: false, message: "View only. Merge on your computer, or pair this phone with View and act.") }
        var payload: [String: Any] = [
            "project": project, "number": page.number, "repository": page.repository.json,
            "method": method, "headSha": page.headSha,
        ]
        switch kind {
        case "merge": payload["type"] = "forge.merge"
        case "enable-auto-merge": payload["type"] = "forge.auto-merge"; payload["action"] = "enable"
        default: payload["type"] = "forge.auto-merge"; payload["action"] = "disable"
        }
        do { return try await service(payload, as: ForgeWrite.self) }
        catch { return ForgeWrite(ok: false, message: error.localizedDescription) }
    }
}
