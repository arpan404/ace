import Testing
import Foundation
@testable import Ace

@Suite @MainActor struct NewThreadDraftTests {
    private func store() -> NewThreadDraftStore {
        NewThreadDraftStore(url: FileManager.default.temporaryDirectory.appendingPathComponent("new-thread-\(UUID().uuidString).json"))
    }
    private let ready = ComposeAgent(provider: "claude", name: "Claude Code", ready: true, status: StatusDisplay(label: "Ready", token: "done"),
                                     reason: nil, accounts: [], models: [])

    @Test func aDraftSurvivesTheAppBeingKilledAndHoldsNoSecrets() throws {
        let file = store()
        let first = NewThreadDraftModel(store: file)
        first.edit { $0.machineId = "host-a"; $0.projectId = "ace"; $0.provider = "claude"; $0.worktree = true; $0.text = "Fix the flaky test @queue.test.ts " }
        // A fresh model over the same file is what the next launch sees.
        let relaunched = NewThreadDraftModel(store: file)
        #expect(relaunched.draft == first.draft)
        #expect(relaunched.draft.text == "Fix the flaky test @queue.test.ts ")
        let saved = try String(contentsOf: file.url, encoding: .utf8)
        #expect(!saved.localizedCaseInsensitiveContains("token") && !saved.localizedCaseInsensitiveContains("secret"))
    }
    @Test func sendingTheSameDraftAgainReusesItsCommandButAnEditStartsAnew() {
        let file = store()
        let drafts = NewThreadDraftModel(store: file)
        drafts.edit { $0.projectId = "ace"; $0.text = "Start" }
        let id = drafts.reserveCommand { "command-1" }
        #expect(NewThreadDraftModel(store: file).reserveCommand { "command-2" } == id)
        drafts.edit { $0.text = "Start" }
        #expect(drafts.reserveCommand { "command-3" } == id)
        drafts.edit { $0.text = "Start now" }
        #expect(drafts.reserveCommand { "command-4" } == "command-4")
    }
    @Test func anAdmittedStartClearsTheWordsAndKeepsTheChoices() {
        let file = store()
        let drafts = NewThreadDraftModel(store: file)
        drafts.edit { $0.machineId = "host-a"; $0.projectId = "ace"; $0.provider = "claude"; $0.text = "Go" }
        _ = drafts.reserveCommand { "command-1" }
        drafts.admitted()
        let next = NewThreadDraftModel(store: file).draft
        #expect(next.text.isEmpty && next.commandId == nil)
        #expect(next.projectId == "ace" && next.provider == "claude" && next.machineId == "host-a")
    }
    @Test func aViewOnlyMachineCanBrowseButCannotStartAThread() async {
        var draft = NewThreadDraft()
        draft.projectId = "ace"; draft.text = "Go"
        #expect(NewThreadGate.blocker(draft, canOperate: false, agent: ready) == NewThreadGate.viewOnly)
        #expect(NewThreadGate.blocker(draft, canOperate: true, agent: ready) == nil)
        let model = ClientModel(now: { 0 })
        model.canOperate = false
        #expect(await model.startThread(draft, commandId: "command-1") == false)
        #expect(await model.addProject(path: "/tmp/notes", requestId: "add-1") == false)
        // Nothing reached the runtime, so nothing failed to send either.
        #expect(model.error == nil)
    }
    @Test func anUnreadyAgentBlocksSendWithItsOwnReason() {
        var draft = NewThreadDraft()
        draft.projectId = "ace"; draft.text = "Go"
        let signedOut = ComposeAgent(provider: "codex", name: "Codex", ready: false, status: StatusDisplay(label: "Sign in needed", token: "needsYou"),
                                     reason: "Signed out. Sign in on your computer.", accounts: [], models: [])
        #expect(NewThreadGate.blocker(draft, canOperate: true, agent: signedOut) == "Signed out. Sign in on your computer.")
    }
    @Test func composePatchesDecodeIntoTheMachinesModel() throws {
        let model = ClientModel(now: { 0 })
        let frame = try JSONSerialization.data(withJSONObject: [
            ["type": "compose.projects", "state": "ready", "projects": [["id": "ace", "name": "ace-next", "path": "/ace", "recent": true]]],
            ["type": "compose.start", "id": "command-1", "ok": true, "threadId": "thread-9", "message": ""],
            ["type": "files.listing", "threadId": "t", "folder": "", "state": "ready", "rows": [["path": "src/", "name": "src", "folder": true]], "hidden": 3, "truncated": false],
        ])
        #expect(model.receive(frame))
        #expect(model.compose.projects.map(\.name) == ["ace-next"])
        #expect(model.compose.started["command-1"]?.id == "thread-9")
        #expect(model.files.listings[""]?.hidden == 3)
    }
}
