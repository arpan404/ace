import Testing
@testable import Ace

@Suite struct ComposerRecallTests {
    /// Walks back the way the composer does: each recall from what the composer shows now.
    private func recall(_ sent: [String], from draft: String, times: Int) -> String {
        var shown = draft
        var last: ComposerRecall?
        for _ in 0..<times {
            let step = ComposerRecall.next(after: last, draft: shown)
            let next = ComposerRecall(older: step.older, recalled: sent[step.older], baseline: step.baseline)
            shown = next.shown
            last = next
        }
        return shown
    }

    @Test func walkingBackKeepsWhatWasTypedBeforeTheFirstRecall() {
        let sent = ["Now run lint", "Fix the flaky test"]
        #expect(recall(sent, from: "Also check CI", times: 1) == "Also check CI\n\nNow run lint")
        #expect(recall(sent, from: "Also check CI", times: 2) == "Also check CI\n\nFix the flaky test")
    }

    @Test func anEmptyComposerShowsJustTheRecalledMessage() {
        #expect(recall(["Now run lint", "Fix the flaky test"], from: "", times: 2) == "Fix the flaky test")
    }

    @Test func typingAfterARecallStartsAgainFromTheLatestAfterTheNewWords() {
        let first = ComposerRecall(older: 0, recalled: "Now run lint", baseline: "")
        let step = ComposerRecall.next(after: first, draft: first.shown + " and tests")
        #expect(step.older == 0)
        #expect(step.baseline == "Now run lint and tests")
    }
}

@Suite struct HoldStripStateTests {
    private let limit = QueueRow.Strip(kind: "limit", sentence: "Codex is out of usage until 1:14 AM", detail: "",
                                       actions: [QueueRow.Action(id: "resume_now", label: "Continue")])

    @Test func aViewOnlyPhoneStillReadsWhyTheTurnWaitsWithItsWaysOnOff() {
        let state = HoldStripState.of(strip: limit, canOperate: false, archived: false)
        #expect(state.visible)
        #expect(!state.actionable)
    }

    @Test func aPhoneThatCanOperateCanTakeTheWaysOn() {
        #expect(HoldStripState.of(strip: limit, canOperate: true, archived: false) == HoldStripState(visible: true, actionable: true))
        #expect(!HoldStripState.of(strip: nil, canOperate: true, archived: false).visible)
    }
}
