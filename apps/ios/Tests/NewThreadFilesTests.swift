import Foundation
import Testing
@testable import Ace

/// Files picked in New thread live with its draft: a killed app puts them back on the message,
/// and their local copies go once the start is saved or the person lets them go.
@Suite @MainActor struct NewThreadFilesTests {
    private func store() -> NewThreadDraftStore {
        NewThreadDraftStore(url: FileManager.default.temporaryDirectory.appendingPathComponent("new-thread-\(UUID().uuidString).json"))
    }
    private func pick(_ drafts: NewThreadDraftModel, _ text: String, project: String = "ace") throws -> StagedAttachment {
        let file = try drafts.staging.stage(data: Data(text.utf8), name: "\(text).txt", mimeType: "text/plain")
        drafts.picked(file, workspaceId: project)
        return file
    }

    @Test func pickedFilesSurviveTheAppBeingKilledAndGoOnceTheStartIsSaved() throws {
        let file = store()
        let drafts = NewThreadDraftModel(store: file)
        drafts.edit { $0.machineId = "host-a"; $0.projectId = "ace"; $0.text = "Read these" }
        let notes = try pick(drafts, "notes")
        let log = try pick(drafts, "log")
        // The next launch reads the same draft and finds both copies to upload again.
        let relaunched = NewThreadDraftModel(store: file)
        #expect(relaunched.restorable == [notes, log])
        #expect(try relaunched.staging.chunk(notes.localId, offset: 0, limit: 64) == Data("notes".utf8).base64EncodedString())
        let saved = try String(contentsOf: file.url, encoding: .utf8)
        #expect(!saved.localizedCaseInsensitiveContains("token") && !saved.localizedCaseInsensitiveContains("secret"))
        _ = relaunched.reserveCommand { "command-1" }
        relaunched.admitted()
        #expect(!relaunched.staging.holds(notes.localId) && !relaunched.staging.holds(log.localId))
        let next = NewThreadDraftModel(store: file)
        #expect(next.restorable.isEmpty && next.draft.projectId == "ace")
    }
    @Test func removingAFileOrChoosingAnotherProjectLetsItsCopyGo() throws {
        let drafts = NewThreadDraftModel(store: store())
        drafts.edit { $0.projectId = "ace" }
        let kept = try pick(drafts, "kept")
        let removed = try pick(drafts, "removed")
        drafts.remove(removed.localId)
        #expect(drafts.restorable == [kept])
        #expect(!drafts.staging.holds(removed.localId) && drafts.staging.holds(kept.localId))
        // Files go with the project they were picked for, as the bridge's draft scope does.
        drafts.edit { $0.projectId = "web" }
        #expect(drafts.restorable.isEmpty && drafts.draft.files.isEmpty)
        #expect(!drafts.staging.holds(kept.localId))
    }
    @Test func aCopyNoDraftNamesIsClearedAndAMissingCopyLeavesTheDraft() throws {
        let file = store()
        let drafts = NewThreadDraftModel(store: file)
        drafts.edit { $0.projectId = "ace" }
        let gone = try pick(drafts, "gone")
        try FileManager.default.removeItem(at: file.files.root.appendingPathComponent(gone.localId))
        // Killed after copying a pick but before the draft named it.
        let orphan = try drafts.staging.stage(data: Data("orphan".utf8), name: "orphan.txt", mimeType: "text/plain")
        let relaunched = NewThreadDraftModel(store: file)
        #expect(relaunched.draft.files.isEmpty)
        #expect(!relaunched.staging.holds(orphan.localId))
    }
    /// Over the real runtime and the spike fixture: the bridge reads a kept file's chunks from the
    /// draft's folder, so a file put back after a relaunch uploads.
    @Test func aFileKeptWithTheDraftUploadsThroughTheBridge() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        let model = ClientModel(now: { 0 })
        defer { Task { await model.disconnectAndWait(); try? FileManager.default.removeItem(at: root) } }
        await model.connect(target: ConnectionTarget(endpoint: try #require(URL(string: "ws://127.0.0.1:\(SpikeFixture.port)")), hostId: "ios-spike-host",
                                                     deviceId: "ios-new-thread-files", pin: nil, credential: { "{\"token\":\"ios-spike-token\"}" }),
                            directory: root)
        try await until { model.connection == "ready" }
        let staging = NewThreadDraftStore.standard().files
        let file = try staging.stage(data: Data("kept across a relaunch".utf8), name: "kept.txt", mimeType: "text/plain")
        defer { staging.discard(file.localId) }
        model.composeAction(["kind": "open"])
        model.composeAttach(file, workspaceId: "ace")
        try await until { model.compose.attachments?.files.first { $0.id == file.localId }?.state == "ready" }
        #expect(model.compose.attachments?.blocked == nil)
    }
    private func until(_ done: () -> Bool) async throws {
        let deadline = ContinuousClock().now.advanced(by: .seconds(25))
        while !done() {
            if ContinuousClock().now >= deadline { Issue.record("timed out"); throw CancellationError() }
            try await Task.sleep(for: .milliseconds(25))
        }
    }
    @Test func aDraftSavedBeforeFilesExistedStillLoadsItsChoices() throws {
        let file = store()
        try Data(#"{"projectId":"ace","provider":"claude","worktree":true,"text":"Go"}"#.utf8).write(to: file.url)
        let draft = NewThreadDraftModel(store: file).draft
        #expect(draft.projectId == "ace" && draft.provider == "claude" && draft.worktree && draft.text == "Go")
        #expect(draft.files.isEmpty)
    }
}
