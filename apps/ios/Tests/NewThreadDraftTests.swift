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
    @Test func startingFromAnIssueOrPullRequestKeepsTheWordsTypedAndLinksOnlyThePickedOne() {
        let ace = ForgeRepository(forge: "github", host: "github.com", owner: "acme", name: "ace")
        let drafts = NewThreadDraftModel(store: store())
        drafts.edit { $0.projectId = "ace"; $0.text = "Look at this first." }
        drafts.edit { $0.start(from: NewThreadStartSeed(text: "Work on GitHub issue #7: Crash", pullRequest: nil,
                                                       issue: NewThreadIssue(repository: ace, number: 7, title: "Crash"))) }
        #expect(drafts.draft.text == "Look at this first.\n\nWork on GitHub issue #7: Crash")
        #expect(drafts.draft.issue?.number == 7)
        // Picking a pull request after it links the pull request in the issue's place.
        drafts.edit { $0.text = "" }
        drafts.edit { $0.start(from: NewThreadStartSeed(text: "Work on GitHub PR #9: Fix",
                                                       pullRequest: NewThreadPull(repository: ace, number: 9, headSha: String(repeating: "a", count: 40), title: "Fix"),
                                                       issue: nil)) }
        #expect(drafts.draft.text == "Work on GitHub PR #9: Fix")
        #expect(drafts.draft.issue == nil)
        #expect(drafts.draft.pullRequest?.number == 9)
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
    private func held() -> (store: NewThreadDraftStore, writer: NewThreadDraftWriter) {
        let writer = NewThreadDraftWriter()
        return (NewThreadDraftStore(url: FileManager.default.temporaryDirectory.appendingPathComponent("new-thread-\(UUID().uuidString).json"), writer: writer), writer)
    }
    /// What the file on disk holds now, read past the writer.
    private func onDisk(_ store: NewThreadDraftStore) -> NewThreadDraft? { DraftFile<NewThreadDraft>(url: store.url).load() }

    @Test func typingAHundredCharactersWritesTheDraftABoundedNumberOfTimes() {
        let (file, writer) = held()
        let pause = HeldDraftPause()
        let drafts = NewThreadDraftModel(store: file, timer: pause)
        drafts.open()
        drafts.edit { $0.projectId = "ace" }
        let typed = String(repeating: "Fix the map. ", count: 8).prefix(100)
        for (index, character) in typed.enumerated() {
            drafts.edit { $0.text.append(character) }
            // The person pauses four times along the way.
            if index % 25 == 24 { pause.end() }
        }
        drafts.leave()
        // One write for the project, one per pause; never one per keystroke.
        #expect(writer.writes <= 5)
        #expect(onDisk(file)?.text == String(typed))
    }
    @Test func leavingTheAppWritesTheLatestDraft() {
        let (file, writer) = held()
        let drafts = NewThreadDraftModel(store: file, timer: HeldDraftPause())
        drafts.open()
        drafts.edit { $0.projectId = "ace"; $0.text = "Half" }
        drafts.edit { $0.text = "Half a thought" }
        writer.settle()
        #expect(onDisk(file)?.text == "Half")
        // The app leaves the screen before typing paused: the words are on disk once leave returns.
        drafts.leave()
        #expect(onDisk(file)?.text == "Half a thought")
        #expect(NewThreadDraftModel(store: file).draft.text == "Half a thought")
    }
    @Test func aChoiceOrAReservedCommandIsOnDiskWithoutWaitingForAPause() {
        let (file, writer) = held()
        let drafts = NewThreadDraftModel(store: file, timer: HeldDraftPause())
        drafts.edit { $0.projectId = "ace"; $0.text = "Go" }
        writer.settle()
        #expect(onDisk(file)?.projectId == "ace")
        drafts.edit { $0.text = "Go now" }
        // Sending saves the words with the command id before it is dispatched.
        let id = drafts.reserveCommand { "command-1" }
        #expect(onDisk(file)?.commandId == id && onDisk(file)?.text == "Go now")
    }
    @Test func aDraftSurvivesTheSheetBeingRebuilt() throws {
        let (file, _) = held()
        file.save(NewThreadDraft(projectId: "ace", text: "Set aside earlier"))
        file.seed(NewThreadDraft(projectId: "ace", text: "Handed over", handoff: "handoff-1"))
        let sheet = NewThreadDraftModel(store: file, timer: HeldDraftPause())
        sheet.open()
        sheet.edit { $0.text = "Handed over, and mine" }
        // A photo is still being copied in, and the words aren't saved yet, when SwiftUI rebuilds
        // the sheet and makes (and throws away) another model over the same draft.
        let photo = try sheet.staging.stage(data: Data("photo".utf8), name: "photo.png", mimeType: "image/png")
        sheet.edit { $0.text = "Handed over, and mine too" }
        _ = NewThreadDraftModel(store: file, timer: HeldDraftPause())
        sheet.picked(photo, workspaceId: "ace")
        sheet.leave()
        #expect(sheet.staging.holds(photo.localId))
        #expect(onDisk(file)?.text == "Handed over, and mine too" && onDisk(file)?.files.map(\.localId) == [photo.localId])
        #expect(file.aside.map(\.text) == ["Set aside earlier"])
    }
    @Test func openingTheSheetTwiceTakesBackOneDraftSetAside() {
        let (file, _) = held()
        file.save(NewThreadDraft(projectId: "ace", text: "First"))
        file.seed(NewThreadDraft(projectId: "ace", text: "Second", handoff: "handoff-1"))
        file.seed(NewThreadDraft(projectId: "ace", handoff: "handoff-2"))
        file.save(NewThreadDraft(projectId: "ace"))
        let sheet = NewThreadDraftModel(store: file)
        sheet.open()
        sheet.open()
        #expect(sheet.draft.text == "Second")
        #expect(file.aside.map(\.text) == ["First"])
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
    @Test func aChatWithNoProjectCanStartWhileADraftWithNoChoiceCannot() throws {
        var draft = NewThreadDraft()
        draft.text = "What's a semaphore?"
        #expect(NewThreadGate.blocker(draft, canOperate: true, agent: ready) == "Choose a project")
        draft.projectId = NewThreadDraft.chat
        #expect(draft.isChat)
        #expect(NewThreadGate.blocker(draft, canOperate: true, agent: ready) == nil)
        // Project lists leave a chat's hidden project out.
        let reply = try JSONDecoder().decode(ProjectListReply.self, from: Data("""
        {"result":{"kind":"projects","projects":[{"id":"ace","name":"ace","path":"/code/ace"},
        {"id":"chat-1","name":"Chat","path":"/data/chats/1","kind":"chat"}]}}
        """.utf8))
        #expect(reply.result.projects?.map(\.id) == ["ace"])
    }
    @Test func anUnreadyAgentBlocksSendWithItsOwnReason() {
        var draft = NewThreadDraft()
        draft.projectId = "ace"; draft.text = "Go"
        let signedOut = ComposeAgent(provider: "codex", name: "Codex", ready: false, status: StatusDisplay(label: "Sign in needed", token: "needsYou"),
                                     reason: "Signed out. Sign in on your computer.", accounts: [], models: [])
        #expect(NewThreadGate.blocker(draft, canOperate: true, agent: signedOut) == "Signed out. Sign in on your computer.")
    }
    @Test func aFirstMessageOfOnlyFilesCanStartButWaitsForTheBridgesReasons() {
        var draft = NewThreadDraft()
        draft.projectId = "ace"
        #expect(NewThreadGate.blocker(draft, canOperate: true, agent: ready) == "Write the first message")
        #expect(NewThreadGate.blocker(draft, canOperate: true, agent: ready, files: 1) == nil)
        #expect(NewThreadGate.blocker(draft, canOperate: true, agent: ready, files: 1,
                                      waits: [nil, "Wait for your files to finish uploading."]) == "Wait for your files to finish uploading.")
    }
    @Test func anAgentsLongModelListLeadsWithTheBridgesChoiceAndKeepsTheRestBehindMore() throws {
        let model = ClientModel(now: { 0 })
        let row: (String) -> [String: Any] = { key in ["key": key, "label": key, "account": "a", "efforts": [], "defaultEffort": NSNull(),
                                                       "speeds": [["speed": "standard", "label": "Standard"], ["speed": "fast", "label": "Fast"]], "defaultSpeed": "standard"] }
        let frame = try JSONSerialization.data(withJSONObject: [
            ["type": "compose.agents", "state": "ready", "start": NSNull(), "providers": [[
                "provider": "codex", "name": "Codex", "ready": true, "status": ["label": "Ready", "token": "done"], "reason": NSNull(),
                "accounts": [], "models": ["in-use", "b", "c", "d", "e", "f"].map(row), "lead": 4,
            ]]],
            ["type": "compose.access", "provider": "codex", "state": "ready", "selected": "ask", "label": "Ask", "stricter": NSNull(), "problem": NSNull(),
             "choices": [["mode": "ask", "label": "Ask", "description": "Asks before edits and commands.", "attention": false]]],
            ["type": "compose.attachments", "workspaceId": "ace", "blocked": "Wait for your files to finish uploading.",
             "files": [["id": "photo-1", "name": "a.png", "kind": "image", "bytes": 10, "state": "uploading", "progress": 0.5, "error": ""]]],
        ])
        #expect(model.receive(frame))
        let agent = try #require(model.compose.agents.first)
        #expect(agent.leading.map(\.key) == ["in-use", "b", "c", "d"])
        #expect(agent.more.map(\.key) == ["e", "f"])
        #expect(agent.models.first?.speeds?.map(\.speed) == ["standard", "fast"])
        #expect(model.compose.access?.selected == "ask")
        #expect(model.compose.attachments?.blocked == "Wait for your files to finish uploading.")
    }
    @Test func composePatchesDecodeIntoTheMachinesModel() throws {
        let model = ClientModel(now: { 0 })
        let frame = try JSONSerialization.data(withJSONObject: [
            ["type": "compose.projects", "state": "ready", "projects": [["id": "ace", "name": "ace-next", "path": "/ace", "recent": true]]],
            ["type": "compose.start", "id": "command-1", "ok": true, "threadId": "thread-9", "message": ""],
            ["type": "files.changed", "seq": 3],
        ])
        #expect(model.receive(frame))
        #expect(model.compose.projects.map(\.name) == ["ace-next"])
        #expect(model.compose.started["command-1"]?.id == "thread-9")
        // Files screens read again once the computer says files changed.
        #expect(model.files.revision == 3)
    }
}
