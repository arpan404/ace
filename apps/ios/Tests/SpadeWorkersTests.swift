import Foundation
import Testing
@testable import Ace

/// A bot's workers row as the bridge puts it (`bridge/spade-worker-rows.ts`) reaches the open chat
/// with each worker's state and where it opens, beside the rows around it.
@MainActor @Suite struct SpadeWorkersTests {
    @Test func aWorkersRowReachesTheChatWithEachWorkersStateAndThread() throws {
        let frame = """
        [{"type":"spade.order","conversation":"c1","order":["s1","s3"]},
         {"type":"spade.row","conversation":"c1","key":"s1","row":{"kind":"person","text":"Research the notes","sending":false,"attached":null}},
         {"type":"spade.row","conversation":"c1","key":"s3","row":{"kind":"workers","title":"Started 2 agents","workers":[
           {"id":"t1","name":"Planner","kind":"ace","thread":"t1","conversation":null,"tone":"needs-you","line":"Waiting for you to approve its plan"},
           {"id":"b1","name":"Scout","kind":"bot","thread":null,"conversation":"c9","tone":"working","line":"Running"}]}}]
        """
        let model = SpadeModel()
        for patch in try JSONDecoder().decode([BridgePatch].self, from: Data(frame.utf8)) {
            if case let .spade(spade) = patch { model.apply(spade) }
        }

        guard case let .workers(workers) = model.bubbles["s3"] else {
            Issue.record("no workers row")
            return
        }
        #expect(model.order == ["s1", "s3"])
        #expect(workers.title == "Started 2 agents")
        #expect(workers.workers.map(\.tone) == ["needs-you", "working"])
        #expect(workers.workers.map(\.thread) == ["t1", nil])
        #expect(workers.workers.map(\.conversation) == [nil, "c9"])
    }
}
