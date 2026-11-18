import Testing
import Foundation
@testable import Ace

/// New thread moved to a machine that lists its projects only after the move (ADR 0180).
@Suite @MainActor struct NewThreadProjectMoveTests {
    private let here = ComposeProject(id: "ace", name: "ace", path: "/Users/ada/ace", recent: true, logical: ["p", "q"])
    private let ciProjects = [
        ComposeProject(id: "notes", name: "notes", path: "/home/ci/notes", recent: true, logical: ["n"]),
        ComposeProject(id: "ace-review", name: "ace-review", path: "/home/ci/review", recent: true, logical: ["q"]),
        ComposeProject(id: "ace-main", name: "ace", path: "/home/ci/ace", recent: false, logical: ["p"]),
    ]

    private func memoryStore() -> NewThreadMemoryStore {
        NewThreadMemoryStore(defaults: UserDefaults(suiteName: "new-thread-move-\(UUID().uuidString)") ?? .standard)
    }
    /// A draft on the laptop in `ace`, with words and a model; the CI machine last opened `notes`.
    private func drafts(_ memory: NewThreadMemoryStore) -> NewThreadDraftModel {
        let file = NewThreadDraftStore(url: FileManager.default.temporaryDirectory.appendingPathComponent("new-thread-move-\(UUID().uuidString).json"))
        let drafts = NewThreadDraftModel(store: file)
        var ci = NewThreadDraft()
        ci.machineId = "ci"; ci.projectId = "notes"; ci.provider = "codex"; ci.model = "gpt"; ci.account = "work"
        memory.remember(ci)
        drafts.edit {
            $0.machineId = "laptop"; $0.projectId = "ace"; $0.provider = "claude"; $0.model = "opus"; $0.text = "Fix the flaky test"
        }
        memory.remember(drafts.draft)
        return drafts
    }
    private func listing(_ state: String, _ rows: [ComposeProject] = []) -> ComposeModel {
        let compose = ComposeModel()
        compose.apply(.projects(state: state, rows))
        return compose
    }

    @Test func aMachineThatListsItsProjectsAfterTheMoveGetsItsCheckoutOfTheProjectLeftRecentFirst() {
        let memory = memoryStore()
        let drafts = drafts(memory)
        var move = NewThreadProjectMove()
        let ci = ComposeModel()
        // First move to a machine this launch: it has listed nothing yet.
        move.move(drafts, to: "ci", leaving: here, there: ci, memory: memory)
        #expect(drafts.draft.machineId == "ci" && drafts.draft.projectId == "notes")
        ci.apply(.projects(state: "loading", []))
        move.listed(drafts, on: "ci", compose: ci, memory: memory)
        #expect(drafts.draft.projectId == "notes")
        ci.apply(.projects(state: "ready", ciProjects))
        move.listed(drafts, on: "ci", compose: ci, memory: memory)
        #expect(drafts.draft.projectId == "ace-review")
        // The words and that machine's own model stay; the base belonged to the other project.
        #expect(drafts.draft.text == "Fix the flaky test" && drafts.draft.machineId == "ci")
        #expect(drafts.draft.provider == "codex" && drafts.draft.model == "gpt" && drafts.draft.account == "work")
        #expect(drafts.draft.base == nil)
        // Settled once: the list read again doesn't move a project picked since.
        drafts.edit { $0.projectId = "notes" }
        move.listed(drafts, on: "ci", compose: ci, memory: memory)
        #expect(drafts.draft.projectId == "notes")
    }

    @Test func aMachineThatHasListedItsProjectsGetsItsCheckoutAtOnce() {
        let memory = memoryStore()
        let drafts = drafts(memory)
        var move = NewThreadProjectMove()
        move.move(drafts, to: "ci", leaving: here, there: listing("ready", ciProjects), memory: memory)
        #expect(drafts.draft.projectId == "ace-review" && drafts.draft.text == "Fix the flaky test")
    }

    @Test func aProjectPickedBeforeTheListArrivesStays() {
        let memory = memoryStore()
        let drafts = drafts(memory)
        var move = NewThreadProjectMove()
        let ci = ComposeModel()
        move.move(drafts, to: "ci", leaving: here, there: ci, memory: memory)
        move.chose()
        drafts.edit { $0 = memory.load().chose(project: "notes", in: $0) }
        ci.apply(.projects(state: "ready", ciProjects))
        move.listed(drafts, on: "ci", compose: ci, memory: memory)
        #expect(drafts.draft.projectId == "notes")
        // A project changed some other way (a handoff, a link) wins the same way.
        var other = NewThreadProjectMove()
        let late = ComposeModel()
        other.move(drafts, to: "laptop", leaving: nil, there: late, memory: memory)
        other.move(drafts, to: "ci", leaving: here, there: late, memory: memory)
        drafts.edit { $0.projectId = "elsewhere" }
        late.apply(.projects(state: "ready", ciProjects))
        other.listed(drafts, on: "ci", compose: late, memory: memory)
        #expect(drafts.draft.projectId == "elsewhere")
    }

    @Test func aListFromAMachineMovedAwayFromNeverMovesTheDraft() {
        let memory = memoryStore()
        let drafts = drafts(memory)
        var move = NewThreadProjectMove()
        let ci = ComposeModel()
        move.move(drafts, to: "ci", leaving: here, there: ci, memory: memory)
        // Straight back to the laptop, which has its list: its own project, nothing waiting.
        move.move(drafts, to: "laptop", leaving: nil, there: listing("ready", [here]), memory: memory)
        #expect(drafts.draft.machineId == "laptop" && drafts.draft.projectId == "ace")
        ci.apply(.projects(state: "ready", ciProjects))
        move.listed(drafts, on: "ci", compose: ci, memory: memory)
        #expect(drafts.draft.machineId == "laptop" && drafts.draft.projectId == "ace")
    }

    @Test func movingOnBeforeAMachineListsCarriesTheProjectLeftToTheNextMachine() {
        let memory = memoryStore()
        let drafts = drafts(memory)
        var move = NewThreadProjectMove()
        let ci = ComposeModel(), build = ComposeModel()
        move.move(drafts, to: "ci", leaving: here, there: ci, memory: memory)
        // The CI machine's project isn't listed, so the sheet has none to leave there.
        move.move(drafts, to: "build", leaving: nil, there: build, memory: memory)
        ci.apply(.projects(state: "ready", ciProjects))
        move.listed(drafts, on: "ci", compose: ci, memory: memory)
        #expect(drafts.draft.machineId == "build" && drafts.draft.projectId == nil)
        build.apply(.projects(state: "ready", [ComposeProject(id: "ace-build", name: "ace", path: "/srv/ace", recent: false, logical: ["p"])]))
        move.listed(drafts, on: "build", compose: build, memory: memory)
        #expect(drafts.draft.projectId == "ace-build" && drafts.draft.text == "Fix the flaky test")
    }

    @Test func aFailedReadOrAListWithoutTheProjectEndsTheWait() {
        let memory = memoryStore()
        let drafts = drafts(memory)
        var move = NewThreadProjectMove()
        let ci = ComposeModel()
        move.move(drafts, to: "ci", leaving: here, there: ci, memory: memory)
        ci.apply(.projects(state: "failed", []))
        move.listed(drafts, on: "ci", compose: ci, memory: memory)
        #expect(drafts.draft.projectId == "notes")
        // A retry that lists it later is an ordinary list: the person's project stays.
        ci.apply(.projects(state: "ready", ciProjects))
        move.listed(drafts, on: "ci", compose: ci, memory: memory)
        #expect(drafts.draft.projectId == "notes")

        var unlisted = NewThreadProjectMove()
        let build = ComposeModel()
        unlisted.move(drafts, to: "build", leaving: here, there: build, memory: memory)
        build.apply(.projects(state: "ready", [ComposeProject(id: "web", name: "web", path: "/srv/web", recent: true, logical: ["w"])]))
        unlisted.listed(drafts, on: "build", compose: build, memory: memory)
        #expect(drafts.draft.projectId == nil)
        build.apply(.projects(state: "ready", [ComposeProject(id: "ace-build", name: "ace", path: "/srv/ace", recent: true, logical: ["p"])]))
        unlisted.listed(drafts, on: "build", compose: build, memory: memory)
        #expect(drafts.draft.projectId == nil)
    }

    /// The sheet's `.task(id: machineId)` on reaching a machine: the draft moves there unless it
    /// is on it, then the opening's project applies, as `NewThreadSheet` does.
    private func reach(_ drafts: NewThreadDraftModel, _ machine: String, _ opening: inout NewThreadOpening,
                       initial: String?, memory: NewThreadMemoryStore) {
        if drafts.draft.machineId != machine { drafts.edit { $0 = memory.load().open($0, on: machine) } }
        if let project = opening.reach(drafts.draft, initialProject: initial) {
            drafts.edit { $0 = memory.load().chose(project: project, in: $0) }
        }
    }
    private func freshDrafts() -> NewThreadDraftModel {
        NewThreadDraftModel(store: NewThreadDraftStore(url: FileManager.default.temporaryDirectory.appendingPathComponent("new-thread-move-\(UUID().uuidString).json")))
    }

    @Test func aProjectsNewThreadMovedToAMachineWithNothingRememberedNeverTakesTheFirstMachinesProjectId() {
        let memory = memoryStore()
        let drafts = freshDrafts()
        var opening = NewThreadOpening(), move = NewThreadProjectMove()
        // New thread from the laptop's `ace` project; the CI machine has never been used.
        reach(drafts, "laptop", &opening, initial: "ace", memory: memory)
        #expect(drafts.draft.machineId == "laptop" && drafts.draft.projectId == "ace")
        drafts.edit { $0.text = "Fix the flaky test" }
        let ci = ComposeModel()
        move.move(drafts, to: "ci", leaving: here, there: ci, memory: memory)
        // The sheet reaches the CI machine before it has listed anything.
        reach(drafts, "ci", &opening, initial: "ace", memory: memory)
        #expect(drafts.draft.machineId == "ci" && drafts.draft.projectId == nil)
        ci.apply(.projects(state: "loading", []))
        move.listed(drafts, on: "ci", compose: ci, memory: memory)
        ci.apply(.projects(state: "ready", ciProjects))
        move.listed(drafts, on: "ci", compose: ci, memory: memory)
        #expect(drafts.draft.projectId == "ace-review" && ciProjects.contains { $0.id == drafts.draft.projectId })
        #expect(drafts.draft.text == "Fix the flaky test")
        // Back on the laptop the logical match finds `ace` again; the opening applies only once.
        move.move(drafts, to: "laptop", leaving: ciProjects[1], there: listing("ready", [here]), memory: memory)
        reach(drafts, "laptop", &opening, initial: "ace", memory: memory)
        #expect(drafts.draft.machineId == "laptop" && drafts.draft.projectId == "ace")
    }

    @Test func aMachineWithNoCheckoutLeavesTheDraftWithoutAProjectRatherThanTheOpeningsOne() {
        let memory = memoryStore()
        let drafts = freshDrafts()
        var opening = NewThreadOpening(), move = NewThreadProjectMove()
        reach(drafts, "laptop", &opening, initial: "ace", memory: memory)
        let build = ComposeModel()
        move.move(drafts, to: "build", leaving: here, there: build, memory: memory)
        reach(drafts, "build", &opening, initial: "ace", memory: memory)
        build.apply(.projects(state: "ready", [ComposeProject(id: "web", name: "web", path: "/srv/web", recent: true, logical: ["w"])]))
        move.listed(drafts, on: "build", compose: build, memory: memory)
        #expect(drafts.draft.machineId == "build" && drafts.draft.projectId == nil)
    }

    @Test func newChatStaysAChatAcrossMachinesAndAProjectPickedSinceStillFindsItsCheckout() {
        let memory = memoryStore()
        let drafts = drafts(memory)
        var opening = NewThreadOpening(), move = NewThreadProjectMove()
        reach(drafts, "laptop", &opening, initial: NewThreadDraft.chat, memory: memory)
        #expect(drafts.draft.isChat)
        // No project is no machine's: a move keeps the chat, though the CI machine last had `notes`.
        move.move(drafts, to: "ci", leaving: nil, there: ComposeModel(), memory: memory)
        reach(drafts, "ci", &opening, initial: NewThreadDraft.chat, memory: memory)
        #expect(drafts.draft.machineId == "ci" && drafts.draft.isChat)
        // Back on the laptop the person picks `ace`, then moves to the CI machine again.
        move.move(drafts, to: "laptop", leaving: nil, there: listing("ready", [here]), memory: memory)
        reach(drafts, "laptop", &opening, initial: NewThreadDraft.chat, memory: memory)
        move.chose()
        drafts.edit { $0 = memory.load().chose(project: "ace", in: $0) }
        let ci = ComposeModel()
        move.move(drafts, to: "ci", leaving: here, there: ci, memory: memory)
        reach(drafts, "ci", &opening, initial: NewThreadDraft.chat, memory: memory)
        #expect(!drafts.draft.isChat)
        ci.apply(.projects(state: "ready", ciProjects))
        move.listed(drafts, on: "ci", compose: ci, memory: memory)
        #expect(drafts.draft.projectId == "ace-review")
    }

    @Test func aProjectOfItsOwnNeverWaits() {
        let memory = memoryStore()
        let drafts = drafts(memory)
        var move = NewThreadProjectMove()
        let own = ComposeProject(id: "scratch", name: "scratch", path: "/s", recent: false)
        let ci = ComposeModel()
        move.move(drafts, to: "ci", leaving: own, there: ci, memory: memory)
        ci.apply(.projects(state: "ready", ciProjects + [ComposeProject(id: "scratch-ci", name: "scratch", path: "/s", recent: true)]))
        move.listed(drafts, on: "ci", compose: ci, memory: memory)
        #expect(drafts.draft.projectId == "notes")
    }
}
