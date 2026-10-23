import XCTest
import QuartzCore
@testable import Ace

/// Budgets for the work a bridge frame costs on the main thread and the frame decoder, so a change
/// that makes the hot paths cost more than the change they carry fails here. Times are per frame,
/// the median of many, in microseconds; the budgets hold in Debug (`Ace` scheme) and `Perf`. See
/// README "Performance budgets".
@MainActor final class MainThreadBudgetTests: XCTestCase {
    /// One streaming edit to the tail of a 2,000-item thread.
    func testAStreamingEditCostsTheSameWhateverTheThreadLength() throws {
        let model = ClientModel(now: { 0 })
        model.open("t")
        let epoch = try XCTUnwrap(model.thread?.epoch)
        try load(model, epoch: epoch, items: 2_000)
        var text = "tail"
        let cost = try perFrame(runs: 400) { index in
            let append = " step \(index)"
            let base = text.utf8.count
            text += append
            return try frame([["type": "thread.item.text", "threadId": "t", "epoch": epoch, "id": "item-1999",
                               "row": item("item-1999", text: "", index: 1999), "base": base, "cut": 0, "append": append]])
        } apply: { XCTAssertTrue(model.receive($0)) }
        XCTAssertEqual(model.thread?.items["item-1999"]?.row.text, text)
        report("streaming edit, 2,000-item thread", cost)
        XCTAssertLessThan(cost, Budget.streamingEditMicros)
    }

    /// One new item at the end of a 2,000-item thread, as each tool call adds one.
    func testANewItemAtTheEndDoesNotResortTheThread() throws {
        let model = ClientModel(now: { 0 })
        model.open("t")
        let epoch = try XCTUnwrap(model.thread?.epoch)
        try load(model, epoch: epoch, items: 2_000)
        let cost = try perFrame(runs: 300) { index in
            try frame([["type": "thread.item", "threadId": "t", "epoch": epoch, "id": "new-\(index)",
                        "row": item("new-\(index)", text: "Ran a command", index: 2_000 + index)]])
        } apply: { XCTAssertTrue(model.receive($0)) }
        XCTAssertEqual(model.thread?.order.count, 2_300)
        XCTAssertEqual(model.thread?.order.last, "new-299")
        report("new item, 2,000-item thread", cost)
        XCTAssertLessThan(cost, Budget.newItemMicros)
    }

    /// One row changing among 500 inbox rows, moving between its sections.
    func testOneInboxRowChangingAmongFiveHundred() throws {
        let model = ClientModel(now: { 0 })
        let ids = (0..<500).map { "thread-\($0)" }
        var labels = Dictionary(uniqueKeysWithValues: ids.map { ($0, "Done") })
        model.receive(try frame([["type": "inbox.reset", "ids": ids]]))
        for chunk in stride(from: 0, to: ids.count, by: 25) {
            model.receive(try frame(ids[chunk..<min(chunk + 25, ids.count)].map { ["type": "inbox.row", "id": $0, "row": inboxRow($0, label: "Done")] }))
        }
        model.receive(try frame([sections(ids, labels: labels)]))
        // Each frame flips one row between Working and Done, and so between the two sections.
        let cost = try perFrame(runs: 300) { index in
            let id = ids[(index * 7) % ids.count]
            labels[id] = labels[id] == "Working" ? "Done" : "Working"
            return try frame([["type": "inbox.row", "id": id, "row": inboxRow(id, label: labels[id] ?? "Done")],
                              sections(ids, labels: labels)])
        } apply: { XCTAssertTrue(model.receive($0)) }
        XCTAssertEqual(model.inbox.count, 500)
        XCTAssertEqual(labels.values.filter { $0 == "Working" }.count, 300)
        for id in ids { XCTAssertEqual(model.inbox[id]?.status.label, labels[id], id) }
        XCTAssertEqual(model.inboxLayout.sections.map(\.key), ["working", "done"])
        XCTAssertEqual(model.inboxLayout.sections.first?.ids, ids.filter { labels[$0] == "Working" })
        XCTAssertEqual(model.inboxLayout.sections.last?.ids, ids.filter { labels[$0] == "Done" })
        report("one inbox row among 500, with sections", cost)
        XCTAssertLessThan(cost, Budget.inboxRowMicros)
    }

    /// Decoding a full 32-patch frame of transcript rows, off the main thread.
    func testDecodingAFullFrame() throws {
        let rows = (0..<32).map { ["type": "thread.item", "threadId": "t", "epoch": 1, "id": "item-\($0)",
                                   "row": item("item-\($0)", text: String(repeating: "Words in a reply. ", count: 40), index: $0)] as [String: Any] }
        let data = try frame(rows)
        XCTAssertLessThanOrEqual(data.count, 32_768)
        var frames = BridgeFrames()
        var decoded: [BridgePatch] = []
        let cost = try perFrame(runs: 200) { _ in data } apply: { decoded = (try? frames.decode($0)) ?? [] }
        // The last decode, read back outside the timed region: every row, in order, whole.
        XCTAssertEqual(decoded.count, 32)
        for (index, patch) in decoded.enumerated() {
            guard case .item(let thread, let epoch, let id, let row) = patch else { return XCTFail("patch \(index) is not an item") }
            XCTAssertEqual([thread, "\(epoch)", id, row?.id], ["t", "1", "item-\(index)", "item-\(index)"])
            XCTAssertEqual(row?.text, String(repeating: "Words in a reply. ", count: 40))
        }
        report("decode a full 32-patch frame (\(data.count) bytes)", cost)
        XCTAssertLessThan(cost, Budget.decodeFullFrameMicros)
    }

    // MARK: - Helpers

    private enum Budget {
        // Measured in Debug on the iOS 26 simulator: 11, 12 (5,780 when a new item re-sorted the
        // thread), 174 and 211 µs.
        static let streamingEditMicros = 100.0
        static let newItemMicros = 150.0
        static let inboxRowMicros = 1_000.0
        static let decodeFullFrameMicros = 1_500.0
    }
    /// The median time `apply` takes on frames made by `make`, which is not timed.
    private func perFrame(runs: Int, _ make: (Int) throws -> Data, apply: (Data) -> Void) throws -> Double {
        var times: [Double] = []
        times.reserveCapacity(runs)
        for index in 0..<runs {
            let data = try make(index)
            let began = CACurrentMediaTime()
            apply(data)
            times.append((CACurrentMediaTime() - began) * 1_000_000)
        }
        return times.sorted()[times.count / 2]
    }
    private func report(_ name: String, _ micros: Double) {
        let line = String(format: "%@: %.0f µs per frame", name, micros)
        print("perf-budget \(line)")
        add(XCTAttachment(string: line))
    }
    private func load(_ model: ClientModel, epoch: Int, items: Int) throws {
        model.receive(try frame([["type": "thread.reset", "threadId": "t", "epoch": epoch]]))
        for chunk in stride(from: 0, to: items, by: 32) {
            model.receive(try frame((chunk..<min(chunk + 32, items)).map {
                ["type": "thread.item", "threadId": "t", "epoch": epoch, "id": "item-\($0)",
                 "row": item("item-\($0)", text: $0 == items - 1 ? "tail" : "History \($0)", index: $0)]
            }))
        }
        XCTAssertEqual(model.thread?.order.count, items)
    }
    private func frame(_ values: [[String: Any]]) throws -> Data { try JSONSerialization.data(withJSONObject: values) }
    private func item(_ id: String, text: String, index: Int) -> [String: Any] {
        ["id": id, "index": index, "type": "message", "role": "assistant", "text": text, "complete": false,
         "createdAt": 0, "agentId": "root", "truncated": false, "detail": "", "quiet": false]
    }
    private func inboxRow(_ id: String, label: String) -> [String: Any] {
        ["id": id, "title": "Thread \(id)", "state": label == "Working" ? "working" : "done", "project": "ace", "branch": "main",
         "machine": "", "provider": "codex", "model": "", "agents": 1, "updatedAt": 1, "canSteer": false,
         "status": ["label": label, "token": label == "Working" ? "working" : "done"], "confirmed": true, "generation": 0]
    }
    /// Working rows first, then Done, as the shared grouping would send them.
    private func sections(_ ids: [String], labels: [String: String]) -> [String: Any] {
        let working = ids.filter { labels[$0] == "Working" }, done = ids.filter { labels[$0] != "Working" }
        return ["type": "inbox.sections", "more": false, "snooze": [],
                "sections": [["key": "working", "label": "Working", "ids": working, "ranks": working.map { "r-\($0)" }, "order": 0],
                             ["key": "done", "label": "Done", "ids": done, "ranks": done.map { "r-\($0)" }, "order": 1]]]
    }
}
