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

    @Test func everyLivePartIsItsOwnPillWithTheStatusFirst() {
        let pill = PillRow(status: status(), segments: [segment("subagents", "2 subagents", opens: "agents"),
                                                        segment("queue", "2 queued", opens: "queue"),
                                                        segment("goal", "Pursuing goal", opens: "goal")])
        let pills = LivePill.of(pill)
        #expect(pills.map(\.id) == ["status", "subagents", "queue", "goal"])
        #expect(pills.map(\.opens) == ["", "agents", "queue", "goal"], "each pill opens what it names; a working status opens nothing")
    }

    @Test func aWaitingStatusOpensTheAgentTree() {
        let pills = LivePill.of(PillRow(status: status(opens: "agents"), segments: []))
        #expect(pills.map(\.opens) == ["agents"])
    }

    @Test func withNoStatusThePartsStillShow() {
        let pills = LivePill.of(PillRow(status: nil, segments: [segment("queue", "3 queued", opens: "queue")]))
        #expect(pills.map(\.id) == ["queue"])
    }

    private func end(_ fromEnd: Double, following: Bool = false, windowApart: Bool = false) -> Bool {
        TranscriptEndButton.shows(.init(fromEnd: fromEnd, slack: 24, following: following, windowApart: windowApart))
    }

    @Test func scrollToEndShowsOnceTheEndIsOutOfViewByMoreThanTheSlack() {
        #expect(!end(0))
        #expect(!end(24))
        #expect(end(25))
        #expect(end(4000))
    }

    @Test func scrollToEndStaysAwayWhileTheFeedFollowsAStreamingEnd() {
        // Text streamed past the bottom before the feed caught up: still following, no flicker.
        #expect(!end(180, following: true))
    }

    @Test func scrollToEndShowsWhileTheHistoryWindowStopsShortOfTheLiveEnd() {
        #expect(end(0, windowApart: true))
        #expect(end(0, following: true, windowApart: true))
    }

    @Test func aFollowingFeedMovedMoreThanAScreenByAnotherScrollStopsFollowing() {
        #expect(TranscriptEndButton.leftByOtherScroll(following: true, fromEnd: 2000, viewport: 800, settling: false))
        #expect(!TranscriptEndButton.leftByOtherScroll(following: true, fromEnd: 300, viewport: 800, settling: false), "streaming growth isn't a scroll away")
        #expect(!TranscriptEndButton.leftByOtherScroll(following: true, fromEnd: 2000, viewport: 800, settling: true), "the feed is still on its way to the end")
        #expect(!TranscriptEndButton.leftByOtherScroll(following: false, fromEnd: 2000, viewport: 800, settling: false))
    }
}
