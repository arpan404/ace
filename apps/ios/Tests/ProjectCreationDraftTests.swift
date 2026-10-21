import Foundation
import Testing
@testable import Ace

@Suite @MainActor struct ProjectCreationDraftTests {
    @Test func retryAfterRelaunchKeepsTheSameCreationAndEditsStartANewOne() throws {
        let file = DraftFile<ProjectCreationDraft>(url: FileManager.default.temporaryDirectory.appendingPathComponent("project-\(UUID().uuidString).json"))
        defer { try? FileManager.default.removeItem(at: file.url) }
        let first = ProjectCreationDraftModel(file: file)
        first.edit { $0.name = "notes"; $0.parent = "/work"; $0.url = "https://example.com/notes.git"; $0.branch = "main" }
        #expect(first.reserve { "create-1" } == "create-1")
        let relaunched = ProjectCreationDraftModel(file: file)
        #expect(relaunched.draft == first.draft)
        #expect(relaunched.reserve { "create-2" } == "create-1")
        relaunched.edit { $0.name = "notes-2" }
        #expect(relaunched.reserve { "create-3" } == "create-3")
        relaunched.received(ok: false)
        let failed = ProjectCreationDraftModel(file: file)
        #expect(failed.draft.name == "notes-2")
        #expect(failed.reserve { "create-4" } == "create-4")
        failed.received(ok: true)
        #expect(ProjectCreationDraftModel(file: file).draft == ProjectCreationDraft())
    }
    @Test func anUnsavableDraftCannotReserveACommand() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("blocked-\(UUID().uuidString)")
        try Data([1]).write(to: root)
        defer { try? FileManager.default.removeItem(at: root) }
        let drafts = ProjectCreationDraftModel(file: DraftFile(url: root.appendingPathComponent("draft.json")))
        drafts.edit { $0.name = "notes" }
        #expect(drafts.reserve { "unsafe-to-send" } == nil)
        #expect(drafts.draft.name == "notes")
        #expect(drafts.problem != nil)
    }
}
