import Testing
@testable import Ace

@Suite @MainActor struct TextExpansionTests {
    @Test func aCutPassageOffersMoreAnOpenOneLessAndOneThatFitsNothing() {
        #expect(TextExpansion.affordance(open: false, clipped: true) == .more)
        #expect(TextExpansion.affordance(open: true, clipped: false) == .less)
        #expect(TextExpansion.affordance(open: true, clipped: true) == .less)
        #expect(TextExpansion.affordance(open: false, clipped: false) == nil)
    }

    @Test func anOpenedPassageStaysOpenWhenItsRowIsDrawnAgain() {
        let screen = Disclosures()
        TextExpansion(store: screen, id: "tool:42").toggle()
        // The row scrolled away and back: a new view reads the same screen's store.
        #expect(TextExpansion(store: screen, id: "tool:42").isOpen)
        #expect(!TextExpansion(store: screen, id: "tool:43").isOpen)
        TextExpansion(store: screen, id: "tool:42").toggle()
        #expect(!TextExpansion(store: screen, id: "tool:42").isOpen)
    }

    @Test func openingAPassageInATranscriptCountsAsAnOpenedFoldSoTheFeedHoldsItsPlace() {
        let thread = Disclosures()
        let before = thread.opens
        TextExpansion(store: thread, id: "block-7").toggle()
        #expect(thread.opens == before + 1)
    }

    @Test func aPassageNeverOpensTheWorkLogThatSharesItsId() {
        let thread = Disclosures()
        TextExpansion(store: thread, id: "block-7").toggle()
        #expect(!thread.isOpen("block-7"))
        thread.toggle("block-7")
        TextExpansion(store: thread, id: "block-7").toggle()
        #expect(thread.isOpen("block-7"))
    }
}
