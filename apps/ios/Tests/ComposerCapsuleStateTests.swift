import Testing
@testable import Ace

@Suite struct ComposerCapsuleStateTests {
    @Test func anEmptyIdleCapsuleOffersTheMicrophone() {
        #expect(ComposerTrailing.of(hasContent: false, busy: false, canStop: false, listening: false) == .dictate)
    }

    @Test func wordsOrChipsMakeTheButtonSendEvenWhileTheTreeWorks() {
        #expect(ComposerTrailing.of(hasContent: true, busy: false, canStop: false, listening: false) == .send)
        #expect(ComposerTrailing.of(hasContent: true, busy: true, canStop: true, listening: false) == .send)
    }

    @Test func anEmptyCapsuleStopsAWorkingTreeOnlyWhenItCanBeStopped() {
        #expect(ComposerTrailing.of(hasContent: false, busy: true, canStop: true, listening: false) == .stop)
        #expect(ComposerTrailing.of(hasContent: false, busy: true, canStop: false, listening: false) == .dictate)
    }

    @Test func dictationKeepsTheButtonUntilItEnds() {
        #expect(ComposerTrailing.of(hasContent: true, busy: true, canStop: true, listening: true) == .listening)
    }

    @Test func thePlaceholderSaysWhatTypingDoesNow() {
        #expect(ComposerPlaceholder.text(fork: false, answering: false, busy: false) == "Ask anything")
        #expect(ComposerPlaceholder.text(fork: false, answering: false, busy: true) == "Steer or queue")
        #expect(ComposerPlaceholder.text(fork: false, answering: true, busy: true) == "Reply or answer")
        #expect(ComposerPlaceholder.text(fork: true, answering: true, busy: true) == "Message the fork")
    }

    private func status(opens: String = "") -> PillRow.Status {
        PillRow.Status(label: "Working", lead: "Working for", since: 1, code: "", live: true, tone: "working", opens: opens)
    }
    private func segment(_ kind: String, _ label: String, opens: String) -> PillRow.Segment {
        PillRow.Segment(kind: kind, label: label, opens: opens, live: false)
    }

    @Test func theQueueIsTheLiveLinesOneActionAndEveryOtherPartStaysInItsSentence() {
        let pill = PillRow(status: status(), segments: [segment("subagents", "2 subagents", opens: "agents"),
                                                        segment("queue", "2 queued", opens: "queue"),
                                                        segment("goal", "Pursuing goal", opens: "goal")])
        let parts = LiveLineParts.of(pill)
        #expect(parts.action?.label == "2 queued")
        #expect(parts.extras.map(\.label) == ["2 subagents", "Pursuing goal"])
        // The status opens nothing itself: the sentence opens the agent tree its subagents name.
        #expect(parts.opens == "agents")
    }

    @Test func theGoalIsTheActionWhenNothingIsQueued() {
        let pill = PillRow(status: status(opens: "agents"), segments: [segment("goal", "Pursuing goal", opens: "goal")])
        let parts = LiveLineParts.of(pill)
        #expect(parts.action?.kind == "goal")
        #expect(parts.extras.isEmpty)
        #expect(parts.opens == "agents")
    }

    @Test func aLonePartWithNoStatusLeadsTheLineInsteadOfFloatingRight() {
        let parts = LiveLineParts.of(PillRow(status: nil, segments: [segment("queue", "3 queued", opens: "queue")]))
        #expect(parts.action == nil)
        #expect(parts.extras.map(\.label) == ["3 queued"])
        #expect(parts.opens == "queue")
    }

    @Test func spokenWordsFollowWhatWasTyped() {
        #expect(DictationText.merged(base: "", spoken: "run the tests") == "run the tests")
        #expect(DictationText.merged(base: "Then", spoken: "run the tests") == "Then run the tests")
        #expect(DictationText.merged(base: "Then ", spoken: " run the tests ") == "Then run the tests")
        #expect(DictationText.merged(base: "Kept", spoken: "  ") == "Kept")
    }
}
