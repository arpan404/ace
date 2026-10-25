import Testing
import Foundation
@testable import Ace

@Suite @MainActor struct NewThreadMachineTests {
    private func memoryStore() -> NewThreadMemoryStore {
        let suite = "new-thread-memory-\(UUID().uuidString)"
        return NewThreadMemoryStore(defaults: UserDefaults(suiteName: suite) ?? .standard)
    }
    private func machine(_ id: String, _ name: String, operate: Bool = true, _ connection: String = "ready") -> NewThreadMachineOption {
        NewThreadMachineOption(hostId: id, name: name, canOperate: operate, connection: connection)
    }

    @Test func withNothingRememberedTheFirstPairedMachineOpensHoweverItsConnectionIsGoing() {
        let paired = ["host-1": "studio-9871", "host-2": "studio-9872"]
        // Which connection answers first differs between launches; the choice doesn't.
        for states in [("connecting", "ready"), ("ready", "connecting"), ("ready", "ready"), ("connecting", "connecting")] {
            let options = [machine("host-1", paired["host-1"] ?? "", states.0), machine("host-2", paired["host-2"] ?? "", states.1)]
            #expect(NewThreadMemory.machine(options, remembered: nil) == "host-1")
        }
    }
    @Test func theMachineAThreadWasStartedOnLastOpensWhileItIsReachable() {
        let options = [machine("host-1", "studio-9871"), machine("host-2", "studio-9872", "connecting")]
        #expect(NewThreadMemory.machine(options, remembered: "host-2") == "host-2")
        let offline = [machine("host-1", "studio-9871"), machine("host-2", "studio-9872", "reconnecting")]
        #expect(NewThreadMemory.machine(offline, remembered: "host-2") == "host-1")
        let viewOnly = [machine("host-1", "studio-9871"), machine("host-2", "studio-9872", operate: false)]
        #expect(NewThreadMemory.machine(viewOnly, remembered: "host-2") == "host-1")
        #expect(NewThreadMemory.machine(options, remembered: "removed-host") == "host-1")
    }
    @Test func aMachineThatCanStartThreadsComesBeforeOneThatCantOrIsDown() {
        let options = [machine("host-1", "studio-9871", operate: false), machine("host-2", "studio-9872", "fatal"), machine("host-3", "studio-9873")]
        #expect(NewThreadMemory.machine(options, remembered: nil) == "host-3")
        #expect(NewThreadMemory.machine([machine("host-1", "a", operate: false)], remembered: nil) == "host-1")
        #expect(NewThreadMemory.machine([], remembered: "host-1") == nil)
    }
    @Test func switchingMachineBringsBackThatMachinesLastProjectAndModel() {
        let store = memoryStore()
        var draft = NewThreadDraft()
        draft.machineId = "host-1"; draft.projectId = "ace"; draft.provider = "claude"; draft.model = "opus"; draft.account = "work"
        store.remember(draft)
        // On the other machine the person picks its project and agent.
        draft = store.load().open(draft, on: "host-2")
        #expect(draft.machineId == "host-2" && draft.projectId == nil && draft.provider == nil)
        draft.projectId = "notes"; draft.provider = "codex"; draft.model = "gpt"; draft.effort = "high"; draft.access = "full"
        store.remember(draft)
        // Back on the first: its project and model, none of the second's tuning.
        draft = store.load().open(draft, on: "host-1")
        #expect(draft.machineId == "host-1" && draft.projectId == "ace")
        #expect(draft.provider == "claude" && draft.model == "opus" && draft.account == "work")
        #expect(draft.effort == nil && draft.access == nil && draft.base == nil)
        draft = store.load().open(draft, on: "host-2")
        #expect(draft.projectId == "notes" && draft.provider == "codex" && draft.model == "gpt")
    }
    @Test func aProjectPickedWithoutAnAgentKeepsTheMachinesLastAgent() {
        let store = memoryStore()
        var draft = NewThreadDraft()
        draft.machineId = "host-1"; draft.projectId = "ace"; draft.provider = "claude"; draft.model = "opus"
        store.record(draft)
        draft.projectId = "web"; draft.provider = nil; draft.model = nil
        store.record(draft)
        let back = store.load().open(NewThreadDraft(), on: "host-1")
        #expect(back.projectId == "web" && back.provider == "claude" && back.model == "opus")
    }
    @Test func theRememberedMachineAndProjectsOutlastARelaunch() {
        let suite = "new-thread-memory-\(UUID().uuidString)"
        var draft = NewThreadDraft()
        draft.machineId = "host-2"; draft.projectId = "notes"
        NewThreadMemoryStore(defaults: UserDefaults(suiteName: suite) ?? .standard).remember(draft)
        let relaunched = NewThreadMemoryStore(defaults: UserDefaults(suiteName: suite) ?? .standard).load()
        let options = [machine("host-1", "studio-9871"), machine("host-2", "studio-9872")]
        #expect(NewThreadMemory.machine(options, remembered: relaunched.machine) == "host-2")
        #expect(relaunched.open(NewThreadDraft(), on: "host-2").projectId == "notes")
    }
    @Test func movingADraftBetweenMachinesKeepsTheWordsAndEachMachinesProject() {
        let file = NewThreadDraftStore(url: FileManager.default.temporaryDirectory.appendingPathComponent("new-thread-\(UUID().uuidString).json"))
        let drafts = NewThreadDraftModel(store: file)
        let store = memoryStore()
        drafts.edit { $0.machineId = "host-1"; $0.projectId = "ace"; $0.text = "Fix it" }
        store.remember(drafts.draft)
        drafts.edit { $0 = store.load().open($0, on: "host-2") }
        drafts.edit { $0.projectId = "notes" }
        store.remember(drafts.draft)
        drafts.edit { $0 = store.load().open($0, on: "host-1") }
        // The words stay with the person; the project is the machine's own.
        #expect(drafts.draft.projectId == "ace" && drafts.draft.text == "Fix it")
        #expect(NewThreadDraftModel(store: file).draft.projectId == "ace")
    }
}
