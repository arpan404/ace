import Testing
import CoreGraphics
@testable import Ace

@Suite struct DockLayoutTests {
    @Test func aLoneAnswerLeavesTheSentencesRowWhenAPagerSharesIt() {
        // "Lost contact…" with "1 of 2" and Stop tracking: the words keep the row.
        #expect(!DockLayout.inlineAction(actions: 1, paged: true))
        #expect(DockLayout.inlineAction(actions: 1, paged: false))
        #expect(!DockLayout.inlineAction(actions: 3, paged: false))
    }

    @Test func onlyADragDownFoldsAnOpenStrip() {
        #expect(DockLayout.collapses(dx: 4, dy: 60))
        #expect(!DockLayout.collapses(dx: -80, dy: 40))
        #expect(!DockLayout.collapses(dx: 0, dy: -60))
    }
}
