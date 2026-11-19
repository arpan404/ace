import Foundation
import Testing
@testable import Ace

/// The bridge's transitions reach the thread screen (`bridge/thread-transitions.ts`): which answer
/// Retry sits under and the parent a fork brings its work back to, and the fork the composer writes.
@MainActor @Suite struct ThreadTransitionsTests {
    private func apply(_ json: String, to screen: ThreadScreenModel) throws {
        let patch = try JSONDecoder().decode(BridgePatch.self, from: Data(json.utf8))
        guard case .screen(_, _, let screenPatch) = patch else { Issue.record("Expected a screen patch"); return }
        screen.apply(screenPatch)
    }

    @Test func retryAndTheParentReachTheMenuAndMessages() throws {
        let screen = ThreadScreenModel()
        try apply(#"{"type":"thread.transitions","threadId":"t","epoch":1,"pi":true,"settled":true,"retry":{"answerId":"a2","askId":"q2"},"lastTurn":true,"parent":{"threadId":"p","ready":true}}"#, to: screen)
        #expect(screen.transitions?.retry?.answerId == "a2")
        #expect(screen.transitions?.parent?.threadId == "p")
        let row = TranscriptRow(id: "a2", index: 3, type: "message", role: "assistant", text: "Done", complete: true, createdAt: 1, agentId: "root",
                                truncated: false, actions: MessageActionsLine(fork: true, edit: false, rewind: true), detail: nil, quiet: nil)
        let transitions = MessageTransitions(row: screen.transitions, fork: { _ in }, edit: { _ in }, retry: { _ in }, rewind: { _ in })
        // Retry under the newest answer takes Rewind's place there.
        #expect(transitions.offered(for: row) == [.fork, .retry])
    }

    @Test func rewindFromAMessagesMenuAsksFirstWhileForkGoesAtOnce() {
        let row = TranscriptRow(id: "a1", index: 1, type: "message", role: "assistant", text: "Plan", complete: true, createdAt: 1, agentId: "root",
                                truncated: false, actions: MessageActionsLine(fork: true, edit: false, rewind: true), detail: nil, quiet: nil)
        var ran: [String] = []
        let transitions = MessageTransitions(row: nil, fork: { ran.append("fork:\($0.id)") }, edit: { _ in }, retry: { _ in },
                                             rewind: { ran.append("rewind:\($0.id)") })
        // Rewind only asks: nothing goes back until the person confirms its question.
        let question = transitions.choose(.rewind, row)
        #expect(question == .rewind)
        #expect(ran.isEmpty)
        if let question { transitions.run(question.action, row) }
        #expect(ran == ["rewind:a1"])
        // Fork has no question: it starts as it's chosen.
        #expect(transitions.choose(.fork, row) == nil)
        #expect(ran == ["rewind:a1", "fork:a1"])
    }

    @Test func aClosedForkLeavesTheComposerOnTheThread() throws {
        let screen = ThreadScreenModel()
        try apply(#"{"type":"thread.fork","threadId":"t","epoch":1,"draft":{"key":"fork:t:run:r1","from":"the last turn","prefill":"","sending":false,"model":"","provider":""}}"#, to: screen)
        #expect(screen.fork?.from == "the last turn")
        try apply(#"{"type":"thread.fork","threadId":"t","epoch":1,"draft":null}"#, to: screen)
        #expect(screen.fork == nil)
    }
}
