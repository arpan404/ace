import Testing
import Foundation
@testable import Ace

/// Starts handed over from the share sheet, Siri and Shortcuts, and what New thread remembers per
/// project.
@Suite @MainActor struct NewThreadHandoffTests {
    private func temp(_ name: String) -> URL {
        FileManager.default.temporaryDirectory.appendingPathComponent("\(name)-\(UUID().uuidString)", isDirectory: true)
    }
    private func handoff(machine: String? = nil, project: String? = nil, text: String = "Fix the map", at seconds: TimeInterval = 0) -> Handoff {
        Handoff(id: UUID().uuidString.lowercased(), created: Date(timeIntervalSince1970: 1_800_000_000 + seconds),
                machineId: machine, projectId: project, text: text, source: .share)
    }
    private func option(_ id: String, operate: Bool = true, _ connection: String = "ready") -> NewThreadMachineOption {
        NewThreadMachineOption(hostId: id, name: id, canOperate: operate, connection: connection)
    }
    private func started(_ machine: String, _ project: String, provider: String, model: String, worktree: Bool, access: String?) -> NewThreadDraft {
        var draft = NewThreadDraft()
        draft.machineId = machine; draft.projectId = project; draft.provider = provider; draft.model = model
        draft.worktree = worktree; draft.access = access; draft.effort = "high"
        return draft
    }

    @Test func choosingAProjectBringsBackWhatItsLastThreadStartedWith() {
        var memory = NewThreadMemory()
        memory.started(started("mac", "ace", provider: "claude", model: "opus", worktree: true, access: "full-access"))
        memory.started(started("mac", "notes", provider: "codex", model: "gpt", worktree: false, access: nil))
        var draft = NewThreadDraft()
        draft.machineId = "mac"; draft.projectId = "notes"; draft.provider = "codex"; draft.model = "gpt"
        draft = memory.chose(project: "ace", in: draft)
        #expect(draft.projectId == "ace" && draft.provider == "claude" && draft.model == "opus")
        #expect(draft.worktree && draft.access == "full-access" && draft.effort == "high")
        // A project with nothing started yet keeps what the draft had.
        draft = memory.chose(project: "web", in: draft)
        #expect(draft.projectId == "web" && draft.provider == "claude" && draft.worktree)
        // A chat never runs in a worktree.
        draft = memory.chose(project: NewThreadDraft.chat, in: draft)
        #expect(!draft.worktree)
    }
    @Test func sameAsLastTimeIsOfferedOnlyOnceThePicksMovedOffTheProjectsLast() {
        var memory = NewThreadMemory()
        let last = started("mac", "ace", provider: "claude", model: "opus", worktree: true, access: nil)
        memory.started(last)
        var draft = memory.chose(project: "ace", in: { var d = NewThreadDraft(); d.machineId = "mac"; return d }())
        #expect(memory.picks(for: draft)?.matches(draft) == true)
        draft.model = "sonnet"
        #expect(memory.picks(for: draft)?.matches(draft) == false)
        draft = memory.picks(for: draft)?.applied(to: draft) ?? draft
        #expect(draft.model == "opus" && memory.picks(for: draft)?.matches(draft) == true)
    }
    @Test func aProjectKeepsItsThreeLatestSkillsNewestFirst() throws {
        var memory = NewThreadMemory()
        var draft = NewThreadDraft()
        draft.machineId = "mac"; draft.projectId = "ace"
        func skill(_ name: String) throws -> NewThreadSkill {
            try #require(NewThreadSkill(SuggestionRow(id: "entry:\(name)", group: "Skills", label: name, detail: nil, icon: "skill", pick: "reference",
                                                      notice: nil, action: nil, parameters: [], reference: .object(["label": .string(name)]))))
        }
        for name in ["review", "fix-failing-tests", "release", "review"] { memory.used(try skill(name), in: draft) }
        #expect(memory.skills(for: draft).map(\.label) == ["review", "release", "fix-failing-tests"])
        memory.used(try skill("deploy"), in: draft)
        #expect(memory.skills(for: draft).map(\.label) == ["deploy", "review", "release"])
        draft.projectId = "notes"
        #expect(memory.skills(for: draft).isEmpty)
        // A command that asks for arguments isn't kept: it needs its form each time.
        let form = SuggestionRow(id: "entry:x", group: "", label: "x", detail: nil, icon: "skill", pick: "arguments", notice: nil, action: nil,
                                 parameters: [], reference: nil)
        #expect(NewThreadSkill(form) == nil)
    }

    @Test func aHandoffStartsOnTheMachineItNamedWhileThatOneCanTakeIt() {
        let named = handoff(machine: "studio", project: "ace")
        let options = [option("mac"), option("studio")]
        #expect(NewThreadHandoff.machine(for: named, options: options, remembered: "mac") == "studio")
        // Unpaired since, or view only: the machine New thread would open on.
        #expect(NewThreadHandoff.machine(for: named, options: [option("mac")], remembered: nil) == "mac")
        #expect(NewThreadHandoff.machine(for: named, options: [option("mac"), option("studio", operate: false)], remembered: nil) == "mac")
        // Nothing can start threads: it waits in the queue.
        #expect(NewThreadHandoff.machine(for: named, options: [option("studio", operate: false)], remembered: nil) == nil)
        #expect(NewThreadHandoff.machine(for: named, options: [], remembered: nil) == nil)
    }
    @Test func aHandoffBecomesADraftThatStartsItselfUnderTheHandoffsId() {
        var memory = NewThreadMemory()
        memory.started(started("mac", "ace", provider: "claude", model: "opus", worktree: true, access: nil))
        let shared = handoff(machine: "mac", project: "ace", text: "Look at this page")
        let draft = NewThreadHandoff.draft(shared, on: "mac", memory: memory, files: [])
        #expect(draft.machineId == "mac" && draft.projectId == "ace" && draft.text == "Look at this page")
        #expect(draft.provider == "claude" && draft.model == "opus" && draft.worktree)
        #expect(draft.commandId == shared.id && draft.handoff == shared.id && draft.autoSend)
        // Landing on another machine: its last project, else a chat, never the other machine's.
        let elsewhere = NewThreadHandoff.draft(shared, on: "studio", memory: memory, files: [])
        #expect(elsewhere.projectId == NewThreadDraft.chat && !elsewhere.worktree)
        let siri = NewThreadHandoff.draft(handoff(text: "Ship it"), on: "mac", memory: memory, files: [])
        #expect(siri.projectId == "ace")
    }

    @Test func theQueueKeepsHandoffsOldestFirstWithTheirFilesUntilTheyAreTaken() throws {
        let store = HandoffStore(root: temp("handoff"))
        let later = handoff(text: "second", at: 10)
        let first = handoff(text: "first", at: 0)
        try store.add(later)
        try store.add(first, files: [(Data("png".utf8), "Screen/shot.png", "image/png")])
        #expect(store.pending().map(\.text) == ["first", "second"])
        let kept = try #require(store.pending().first?.files.first)
        #expect(kept.name == "Screen/shot.png" && !kept.stored.contains("/"))
        #expect(try Data(contentsOf: store.file(first, kept)) == Data("png".utf8))
        store.remove(first.id)
        #expect(store.pending().map(\.text) == ["second"])
        #expect(!FileManager.default.fileExists(atPath: store.folder(first.id).path))
        // A handoff whose id isn't a UUID can't name a path.
        #expect(throws: (any Error).self) { try store.add(Handoff(id: "../x", created: Date(timeIntervalSince1970: 0), text: "", source: .share)) }
    }
    @Test func theShareSheetOffersEachMachinesProjectsAndAChatAndKeepsOnesNotReadThisTime() {
        var memory = NewThreadMemory()
        memory.machine = "mac"
        memory.choices["mac"] = .init(projectId: "notes")
        let first = HandoffCatalogue.make(machines: [
            (id: "mac", name: "MacBook Pro", canOperate: true, projects: [ComposeProject(id: "ace", name: "ace", path: "/a", recent: true),
                                                                           ComposeProject(id: "notes", name: "notes", path: "/n", recent: false)]),
            (id: "ipad", name: "Viewer", canOperate: false, projects: nil),
        ], previous: HandoffCatalogue(), memory: memory)
        #expect(first.projects.map(\.name) == ["ace", "notes", "No project"])
        #expect(first.suggested?.projectId == "notes")
        #expect(first.machineName("mac") == "MacBook Pro")
        // Projects not read on this pass stay as they were read before.
        let second = HandoffCatalogue.make(machines: [(id: "mac", name: "MacBook Pro", canOperate: true, projects: nil)], previous: first, memory: memory)
        #expect(second.projects.map(\.projectId) == ["ace", "notes", "chat"])
        #expect(second.machineName("mac") == nil)
    }

    @Test func aHandoffSetsThePersonsDraftAsideAndGivesItBackOnceItIsSaved() {
        let file = NewThreadDraftStore(url: temp("drafts").appendingPathComponent("new-thread-draft.json"))
        let mine = NewThreadDraftModel(store: file)
        mine.edit { $0.machineId = "mac"; $0.projectId = "ace"; $0.text = "My own half-written idea" }
        file.seed(NewThreadHandoff.draft(handoff(machine: "mac", project: "ace", text: "Shared link"), on: "mac", memory: NewThreadMemory(), files: []))
        let sheet = NewThreadDraftModel(store: file)
        #expect(sheet.draft.text == "Shared link" && sheet.draft.autoSend)
        sheet.admitted()
        #expect(sheet.draft.text == "My own half-written idea" && sheet.draft.handoff == nil)
        #expect(file.aside.isEmpty)
    }
    @Test func everyDraftAHandoffDisplacesComesBackWholeOneAtATimeNeverJoined() {
        let file = NewThreadDraftStore(url: temp("drafts").appendingPathComponent("new-thread-draft.json"))
        let sheet = NewThreadDraftModel(store: file)
        sheet.edit { $0.machineId = "mac"; $0.projectId = "ace"; $0.text = "First idea" }
        // A share arrives; the person closes the sheet without sending it and keeps editing it.
        file.seed(NewThreadHandoff.draft(handoff(text: "Shared page"), on: "mac", memory: NewThreadMemory(), files: []))
        let second = NewThreadDraftModel(store: file)
        second.edit { $0.autoSend = false; $0.text = "Shared page, with my notes" }
        // A second share takes the sheet: neither earlier draft may be lost or merged.
        file.seed(NewThreadHandoff.draft(handoff(text: "Second share"), on: "mac", memory: NewThreadMemory(), files: []))
        let third = NewThreadDraftModel(store: file)
        #expect(third.draft.text == "Second share")
        third.admitted()
        #expect(third.draft.text == "Shared page, with my notes" && !third.draft.autoSend)
        third.admitted()
        #expect(third.draft.text == "First idea")
        third.admitted()
        #expect(third.draft.text == "" && file.aside.isEmpty)
    }
    @Test func aDraftSetAsideReturnsWhenTheSheetOpensEmpty() {
        let file = NewThreadDraftStore(url: temp("drafts").appendingPathComponent("new-thread-draft.json"))
        NewThreadDraftModel(store: file).edit { $0.projectId = "ace"; $0.text = "Mine" }
        file.seed(NewThreadHandoff.draft(handoff(text: "Shared"), on: "mac", memory: NewThreadMemory(), files: []))
        // The person cleared the handed-over words and closed the sheet.
        NewThreadDraftModel(store: file).edit { $0.text = ""; $0.autoSend = false; $0.handoff = nil }
        let reopened = NewThreadDraftModel(store: file)
        reopened.open()
        #expect(reopened.draft.text == "Mine")
    }
    @Test func aHandoffNeverDiscardsOrMergesTheWordsThePersonIsStillTyping() {
        let file = NewThreadDraftStore(url: temp("drafts").appendingPathComponent("new-thread-draft.json"), writer: NewThreadDraftWriter())
        let pause = HeldDraftPause()
        let sheet = NewThreadDraftModel(store: file, timer: pause)
        sheet.open()
        sheet.edit { $0.machineId = "mac"; $0.projectId = "ace"; $0.text = "My idea" }
        // Typing that hasn't paused yet when a share arrives.
        sheet.edit { $0.text = "My idea, half written" }
        let shared = NewThreadHandoff.draft(handoff(text: "Shared link"), on: "mac", memory: NewThreadMemory(), files: [])
        sheet.takeHandoff { store in store.seed(shared); return true }
        #expect(sheet.draft.text == "Shared link" && sheet.draft.autoSend)
        #expect(file.aside.map(\.text) == ["My idea, half written"])
        // The pause the person's typing was waiting for ends later; it writes nothing over the share.
        pause.end()
        sheet.leave()
        #expect(NewThreadDraftModel(store: file).draft.text == "Shared link")
        sheet.admitted()
        #expect(sheet.draft.text == "My idea, half written" && sheet.draft.handoff == nil && file.aside.isEmpty)
    }
    @Test func typingInAHandedOverDraftStopsItStartingByItself() {
        let file = NewThreadDraftStore(url: temp("drafts").appendingPathComponent("new-thread-draft.json"))
        file.seed(NewThreadHandoff.draft(handoff(text: "Shared"), on: "mac", memory: NewThreadMemory(), files: []))
        let sheet = NewThreadDraftModel(store: file)
        sheet.edit { $0.projectId = "ace" }
        #expect(sheet.draft.autoSend)
        sheet.edit { $0.text = "Shared, but first check the logs" }
        #expect(!sheet.draft.autoSend && sheet.draft.handoff != nil)
    }

    @Test func dictationWritesAfterTheWordsAlreadyThere() {
        #expect(DictationText.join("", heard: " Fix the map ") == "Fix the map")
        #expect(DictationText.join("Look at", heard: "the fleet map") == "Look at the fleet map")
        #expect(DictationText.join("Done.\n", heard: "Next") == "Done.\nNext")
        #expect(DictationText.join("Keep me", heard: "  ") == "Keep me")
    }
}
