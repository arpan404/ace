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
