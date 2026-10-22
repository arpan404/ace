import Testing
import Foundation
@testable import Ace

@Suite @MainActor struct ForgeTests {
    private func store() -> NewThreadDraftStore {
        NewThreadDraftStore(url: FileManager.default.temporaryDirectory.appendingPathComponent("forge-draft-\(UUID().uuidString).json"))
    }
    private let issue = NewThreadIssue(repository: ForgeRepository(forge: "github", host: "github.com", owner: "acme", name: "ace"),
                                       number: 240, title: "Sidebar loses its scroll position")

    @Test func startingFromAnIssueWritesTheFirstMessageAndLinkKeepingTheAgentChosenOnThatMachine() {
        let file = store()
        NewThreadDraftModel(store: file).edit { $0.machineId = "host-a"; $0.projectId = "web"; $0.provider = "codex"; $0.model = "gpt"; $0.text = "Old words" }
        file.seed(machineId: "host-a", projectId: "ace", text: "Work on GitHub issue #240", issue: issue)
        let draft = NewThreadDraftModel(store: file).draft
        #expect(draft.projectId == "ace" && draft.text == "Work on GitHub issue #240" && draft.issue == issue)
        #expect(draft.provider == "codex" && draft.model == "gpt")
    }
    @Test func startingFromAnIssueOnAnotherMachineDropsTheAgentChosenForTheFirst() {
        let file = store()
        NewThreadDraftModel(store: file).edit { $0.machineId = "host-a"; $0.provider = "codex"; $0.model = "gpt" }
        file.seed(machineId: "host-b", projectId: "ace", text: "Go", issue: issue)
        let draft = NewThreadDraftModel(store: file).draft
        #expect(draft.machineId == "host-b" && draft.provider == nil && draft.model == nil)
    }
    @Test func theIssueGoesWhenAnotherProjectIsChosenOrTheThreadStarts() {
        let file = store()
        file.seed(machineId: "host-a", projectId: "ace", text: "Go", issue: issue)
        let drafts = NewThreadDraftModel(store: file)
        drafts.edit { $0.text = "Go now" }
        #expect(drafts.draft.issue == issue)
        drafts.edit { $0.projectId = "web" }
        #expect(drafts.draft.issue == nil)
        file.seed(machineId: "host-a", projectId: "ace", text: "Go", issue: issue)
        let again = NewThreadDraftModel(store: file)
        _ = again.reserveCommand { "command-1" }
        again.admitted()
        #expect(NewThreadDraftModel(store: file).draft.issue == nil)
    }
    @Test func aPageOnTheSecondTabTravelsThroughTheStackPathAndIsNotAThread() {
        let route = ForgeRoute(kind: .issue, machineId: "host|a", project: "34c9", number: 240)
        let thread = InboxKey(machineId: "host|a", id: "thread-1")
        let path: [InboxRoute] = [.forge(route), .thread(thread)]
        #expect(path.first == .forge(route))
        #expect(InboxRoute.threads(path) == [thread])
        #expect(InboxRoute.threads([.forge(route)]).isEmpty)
    }
    @Test func theListsFollowTheInboxProjectElseTheLastChosenElseTheFirst() {
        let projects = [ForgeProject(id: "a", name: "ace"), ForgeProject(id: "b", name: "web")]
        #expect(ForgeProjectChoice.pick(chip: "b", remembered: "a", projects: projects) == "b")
        #expect(ForgeProjectChoice.pick(chip: "", remembered: "b", projects: projects) == "b")
        #expect(ForgeProjectChoice.pick(chip: "gone", remembered: "gone", projects: projects) == "a")
        #expect(ForgeProjectChoice.pick(chip: "", remembered: nil, projects: []) == nil)
    }
    @Test func filtersSendOnlyWhatDiffersFromTheWebsDefaults() {
        var pulls = PullsFilter()
        #expect(pulls.json(query: "  ").isEmpty)
        pulls.state = "merged"; pulls.review = "approved"; pulls.labels = ["bug"]
        let json = pulls.json(query: " crash ")
        #expect(json["state"] as? String == "merged" && json["review"] as? String == "approved")
        #expect(json["labels"] as? [String] == ["bug"] && json["q"] as? String == "crash")
        #expect(pulls.narrowing == 2)
    }
}
