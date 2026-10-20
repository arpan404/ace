import CryptoKit
import Foundation
import Observation

struct ProjectCreationDraft: Codable, Equatable, Sendable {
    var parent = ""
    var name = ""
    var url = ""
    var git = true
    var branch = ""
    var gitignore = ""
    var commandId: String?
}

@MainActor @Observable final class ProjectCreationDraftModel {
    private(set) var draft: ProjectCreationDraft
    private(set) var problem: String?
    private let file: DraftFile<ProjectCreationDraft>
    init(file: DraftFile<ProjectCreationDraft>) { self.file = file; draft = file.load() ?? ProjectCreationDraft() }
    convenience init(hostId: String, cloning: Bool) {
        let scope = SHA256.hash(data: Data(hostId.utf8)).map { String(format: "%02x", $0) }.joined()
        let root = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("ace", isDirectory: true)
        self.init(file: DraftFile(url: root.appendingPathComponent("project-\(scope)-\(cloning ? "clone" : "create").json")))
    }
    func edit(_ change: (inout ProjectCreationDraft) -> Void) {
        var next = draft; change(&next)
        guard next != draft else { return }
        next.commandId = nil; draft = next
        persist()
    }
    /// A failed or uncertain connection reuses this identity even after relaunch.
    func reserve(make: () -> String) -> String? {
        if draft.commandId == nil { draft.commandId = make() }
        guard persist() else { return nil }
        return draft.commandId
    }
    func received(ok: Bool) {
        if ok { draft = ProjectCreationDraft() } else { draft.commandId = nil }
        persist()
    }
    @discardableResult private func persist() -> Bool {
        do { try file.save(draft); problem = nil; return true }
        catch { problem = "Couldn't save this draft on your phone. \(error.localizedDescription)"; return false }
    }
}
