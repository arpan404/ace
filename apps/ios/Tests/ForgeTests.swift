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
    @Test func aConfirmedMergeSendsTheHeadAndMethodItWasAskedAgainstAndARefreshEndsTheQuestion() throws {
        let asked = try pullPage(head: "aaa111")
        let merge = try #require(asked.action)
        let target = ForgeWriteTarget(action: merge, project: "ace", page: asked, method: "squash")
        let refreshed = try pullPage(head: "bbb222")
        #expect(target.payload["headSha"] as? String == "aaa111")
        #expect(target.payload["method"] as? String == "squash" && target.payload["type"] as? String == "forge.merge")
        #expect(target.matches(asked, method: "squash"))
        #expect(!target.matches(refreshed, method: "squash"))
        #expect(!target.matches(asked, method: "rebase"))
    }
    @Test func rowsKeptOnScreenWhileAnotherProjectReadsStillOpenInTheProjectTheyCameFrom() async throws {
        let model = ForgeListModel<ForgePullList>()
        let first = ForgeListScope(machineId: "mac", project: "a")
        let second = ForgeListScope(machineId: "mac", project: "b")
        let rows = try pullList()
        await model.load("a", scope: first) { _, _ in rows }
        #expect(model.scope == first)
        let (gate, open) = AsyncStream<Void>.makeStream()
        let reading = Task { await model.load("b", scope: second) { _, _ in
            for await _ in gate { break }
            return rows
        } }
        for _ in 0..<20 { await Task.yield() }
        // Project a's rows stay, dimmed, and still open in project a.
        #expect(model.stale && model.scope == first)
        open.yield(); open.finish()
        await reading.value
        #expect(!model.stale && model.scope == second)
    }
    private func pullList() throws -> ForgePullList {
        let json: [String: Any] = ["repository": "acme/ace", "groups": [], "more": false, "authors": [], "labels": []]
        return try JSONDecoder().decode(ForgePullList.self, from: JSONSerialization.data(withJSONObject: json))
    }
    private func pullPage(head: String) throws -> ForgePullPage {
        let json: [String: Any] = [
            "number": 42, "repository": ["forge": "github", "host": "github.com", "owner": "acme", "name": "ace"],
            "title": "Fix", "url": "https://github.com/acme/ace/pull/42", "state": ["word": "Open", "tone": "working"],
            "merged": false, "author": "a", "headBranch": "fix", "baseBranch": "main", "headSha": head,
            "commits": 1, "changedFiles": 1, "body": "", "bodyBlocks": [], "tasks": false, "conversation": "", "labels": [], "gates": [], "primary": "",
            "action": ["kind": "merge", "label": "Squash and merge"], "blockers": [],
            "methods": [], "method": "squash", "reviewers": [], "checks": [], "files": [], "threads": [],
        ]
        return try JSONDecoder().decode(ForgePullPage.self, from: JSONSerialization.data(withJSONObject: json))
    }

    // MARK: Viewed names the version on screen

    private func revisions(head: String, prHead: String) -> ForgeFileRevisions {
        let json = #"{"base":"\#(String(repeating: "b", count: 40))","head":"\#(head)","prHead":"\#(prHead)","path":"docs/guide.md","previousPath":null,"status":"modified"}"#
        return try! JSONDecoder().decode(ForgeFileRevisions.self, from: Data(json.utf8))
    }

    @Test func aRenderedViewStillShowingTheOldPushMarksNothingUntilItDrawsTheNewOne() {
        let old = revisions(head: String(repeating: "1", count: 40), prHead: String(repeating: "1", count: 40))
        let pushed = revisions(head: String(repeating: "2", count: 40), prHead: String(repeating: "2", count: 40))
        // The page read the push; the rendered view still has the old version on screen.
        #expect(ForgeViewedVersion.head(patchHead: pushed.prHead, current: pushed, drawsSides: true, shown: old) == nil)
        #expect(ForgeViewedVersion.head(patchHead: pushed.prHead, current: pushed, drawsSides: true, shown: nil) == nil)
        // Once it has drawn the pushed commits, Viewed names that head.
        #expect(ForgeViewedVersion.head(patchHead: pushed.prHead, current: pushed, drawsSides: true, shown: pushed) == pushed.prHead)
    }

    @Test func thePatchIsAlwaysTheVersionThePageRead() {
        let current = revisions(head: String(repeating: "3", count: 40), prHead: String(repeating: "3", count: 40))
        #expect(ForgeViewedVersion.head(patchHead: current.prHead, current: current, drawsSides: false, shown: nil) == current.prHead)
    }
}
