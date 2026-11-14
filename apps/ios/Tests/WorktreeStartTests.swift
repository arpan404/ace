import Foundation
import Testing
@testable import Ace

/// After Send on New thread in a worktree: the card speaks while the worktree is made or stopped,
/// the thread opens once it exists, and a refusal with no card left is said in the daemon's words.
@Suite struct WorktreeStartTests {
    private let card = WorktreeStartCard(headline: "Creating a worktree", running: true, failed: false,
                                         steps: [.init(label: "Preparing workspace", state: "running", elapsedMs: 0, percent: nil)],
                                         note: "", refused: "", locked: false,
                                         actions: [.init(id: "cancel", label: "Cancel")], sending: "", details: [])

    @Test func aWorktreeStartsCardDecodesWithItsStepsAndActions() throws {
        let json = #"{"type":"compose.worktree","id":"c-1","made":null,"card":{"headline":"Creating a worktree","running":true,"failed":false,"steps":[{"label":"Checking out files","state":"running","elapsedMs":40,"percent":48}],"note":"","refused":"","locked":false,"actions":[{"id":"local","label":"Don't use worktree"}],"sending":"","details":["Checking out files: 48%"]}}"#
        let patch = try JSONDecoder().decode(ComposePatch.self, from: Data(json.utf8))
        guard case .worktree(let id, let read) = patch else { Issue.record("not a worktree card"); return }
        #expect(id == "c-1")
        #expect(read.card?.steps.first?.percent == 48)
        #expect(read.card?.actions.map(\.label) == ["Don't use worktree"])
        #expect(read.made == nil)
    }

    @Test func theStartWaitsWhileItsWorktreeIsBeingMade() {
        #expect(NewThreadWait.next(outcome: nil, worktree: WorktreeStartRead(card: card), listed: { _ in true }) == .wait)
    }

    @Test func theThreadOpensOnceTheReceiptNamesItAndItIsListed() {
        let outcome = ComposeOutcome(ok: true, id: "t-1", message: "")
        #expect(NewThreadWait.next(outcome: outcome, worktree: nil, listed: { _ in false }) == .wait)
        #expect(NewThreadWait.next(outcome: outcome, worktree: nil, listed: { $0 == "t-1" }) == .open("t-1"))
    }

    @Test func aThreadMadeAfterRetryOrOnTheLocalCheckoutOpensFromItsWorktreeReport() {
        let refused = ComposeOutcome(ok: false, id: nil, message: "Worktree cancelled")
        #expect(NewThreadWait.next(outcome: refused, worktree: WorktreeStartRead(card: nil, made: "t-2"), listed: { _ in true }) == .open("t-2"))
    }

    @Test func aRefusalTheCardSpeaksForKeepsTheCardInsteadOfAnAlert() {
        let refused = ComposeOutcome(ok: false, id: nil, message: "Worktree cancelled")
        #expect(NewThreadWait.next(outcome: refused, worktree: WorktreeStartRead(card: card), listed: { _ in true }) == .wait)
    }

    @Test func aRefusalWithNoCardLeftIsSaidInTheDaemonsWords() {
        let refused = ComposeOutcome(ok: false, id: nil, message: "This project isn't a Git repository, so it can't have worktrees.")
        #expect(NewThreadWait.next(outcome: refused, worktree: nil, listed: { _ in true })
            == .refused("This project isn't a Git repository, so it can't have worktrees."))
        #expect(NewThreadWait.next(outcome: ComposeOutcome(ok: false, id: nil, message: ""), worktree: nil, listed: { _ in true })
            == .refused("The thread didn't start."))
    }
}
