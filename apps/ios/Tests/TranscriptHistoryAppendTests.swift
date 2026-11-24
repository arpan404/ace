import CoreGraphics
import Testing
@testable import Ace

@MainActor @Suite struct TranscriptHistoryAppendTests {
    @Test func aPageMayCompleteAPartialTurnBeyondTheProtectedRows() {
        let model = historyWindow()
        let page: [BridgePatch] = [
            .block("thread", -1, "partial", nil),
            .block("thread", -1, "complete", block(0, items: ["older", "partial"])),
        ]

        #expect(TranscriptHistoryAppend.preservesRows(page, replacing: model, shown: model,
                                                     oldestProtected: "reader", retainedNewer: []))
        #expect(!TranscriptHistoryAppend.preservesRows(page, replacing: model, shown: model,
                                                      oldestProtected: "partial", retainedNewer: []))
    }

    @Test func aPageMayNotInsertBetweenTheReaderAndTheLiveEdge() {
        let model = historyWindow()
        let page: [BridgePatch] = [
            .blockPosition("thread", -1, "newest", 3),
            .block("thread", -1, "inserted", block(2, items: ["inserted"])),
        ]

        #expect(!TranscriptHistoryAppend.preservesRows(page, replacing: model, shown: model,
                                                      oldestProtected: "reader", retainedNewer: []))
    }

    @Test func theRowsHalfAScreenAheadAreProtectedFromTheLayoutsFramesThoughNoCellShowedThem() {
        // An 800-point viewport: the band runs from half a screen past its top to its bottom.
        let frames: [String: CGRect] = [
            "partial": CGRect(x: 0, y: -1_200, width: 320, height: 500),
            "ahead": CGRect(x: 0, y: -700, width: 320, height: 600),
            "reader": CGRect(x: 0, y: -100, width: 320, height: 600),
            "newest": CGRect(x: 0, y: 500, width: 320, height: 400),
        ]
        let order = ["partial", "ahead", "reader", "newest"]

        #expect(TranscriptHistoryAppend.oldestProtected(order, frame: { frames[$0] }, ahead: -400, bottom: 800)
            == .block("ahead"))
    }

    @Test func aPageWaitsWhenARowInTheWindowHasNoFrame() {
        let frames: [String: CGRect] = ["reader": CGRect(x: 0, y: 0, width: 320, height: 600)]

        #expect(TranscriptHistoryAppend.oldestProtected(["ahead", "reader"], frame: { frames[$0] }, ahead: -400,
                                                        bottom: 800) == .unknown)
    }

    private func historyWindow() -> ThreadModel {
        let model = ThreadModel(id: "thread")
        for (index, id) in ["partial", "reader", "newest"].enumerated() {
            model.screen.apply(.block("thread", -1, id, block(index, items: [id])))
        }
        model.screen.commit()
        return model
    }

    private func block(_ index: Int, items: [String]) -> BlockRow {
        BlockRow(index: index, kind: "message", items: items, headed: false, interactionId: "",
                 work: nil, agents: nil, ending: nil, started: nil)
    }
}
