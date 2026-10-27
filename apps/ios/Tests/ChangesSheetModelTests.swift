import Testing
import Foundation
@testable import Ace

/// The Changes sheet's state as the bridge's patches build it (`bridge/CHANGES-CONTRACT.md`).
@Suite @MainActor struct ChangesSheetModelTests {
    private func apply(_ json: String, to sheets: ThreadSheetsModel) throws {
        let patch = try JSONDecoder().decode(BridgePatch.self, from: Data(json.utf8))
        switch patch {
        case .changesSummary(_, _, let summary): sheets.apply(summary)
        case .changes(_, _, let change): sheets.apply(change)
        default: Issue.record("Unexpected patch \(patch)")
        }
    }
    private func header(_ path: String, file: String, version: String, pages: Int) -> String {
        """
        {"type":"changes.file","threadId":"t","epoch":1,"file":"\(file)","path":"\(path)","version":"\(version)","state":"ready","message":"","binary":false,"pages":\(pages),"rows":3,"remaining":0,"complete":true,"cut":false,"empty":false,"viewed":false}
        """
    }
    private func page(_ path: String, file: String, version: String, index: Int, rows: [(Int, String)]) -> String {
        let lines = rows.map { "{\"i\":\($0.0),\"kind\":\"add\",\"old\":null,\"new\":\($0.0 + 1),\"text\":\"\($0.1)\",\"length\":\($0.1.count),\"clipped\":false,\"count\":null}" }
        return "{\"type\":\"changes.page\",\"threadId\":\"t\",\"epoch\":1,\"file\":\"\(file)\",\"path\":\"\(path)\",\"version\":\"\(version)\",\"index\":\(index),\"layout\":\"unified\",\"lines\":[\(lines.joined(separator: ","))]}"
    }
    private func summary(open: [String]) -> String {
        let paths = open.map { "\"\($0)\"" }.joined(separator: ",")
        return """
        {"type":"changes.summary","threadId":"t","epoch":1,"state":"ready","message":"","files":[],"hidden":0,"partial":false,"totals":{"files":0,"additions":0,"deletions":0},"patchTruncated":false,"branch":"main","step":{"kind":"none","label":"","detail":"","blocked":null,"pr":null},"busy":false,"open":[\(paths)],"openLimit":30,"layout":"unified"}
        """
    }

    @Test func pagesJoinInOrderAndStopAtAMissingOne() throws {
        let sheets = ThreadSheetsModel()
        try apply(header("a.ts", file: "f1", version: "v1", pages: 3), to: sheets)
        try apply(page("a.ts", file: "f1", version: "v1", index: 1, rows: [(1, "second")]), to: sheets)
        try apply(page("a.ts", file: "f1", version: "v1", index: 0, rows: [(0, "first")]), to: sheets)
        try apply(page("a.ts", file: "f1", version: "v1", index: 3, rows: [(5, "after a gap")]), to: sheets)
        let file = try #require(sheets.files["a.ts"])
        #expect(sheets.rows(file).map(\.text) == ["first", "second"])
    }

    @Test func aNewDiffVersionDropsTheOldPagesAndIgnoresLatePagesOfIt() throws {
        let sheets = ThreadSheetsModel()
        try apply(header("a.ts", file: "f1", version: "v1", pages: 1), to: sheets)
        try apply(page("a.ts", file: "f1", version: "v1", index: 0, rows: [(0, "old")]), to: sheets)
        try apply(header("a.ts", file: "f1", version: "v2", pages: 1), to: sheets)
        try apply(page("a.ts", file: "f1", version: "v1", index: 0, rows: [(0, "late old")]), to: sheets)
        var file = try #require(sheets.files["a.ts"])
        #expect(sheets.rows(file).isEmpty)
        try apply(page("a.ts", file: "f1", version: "v2", index: 0, rows: [(0, "new")]), to: sheets)
        file = try #require(sheets.files["a.ts"])
        #expect(sheets.rows(file).map(\.text) == ["new"])
    }

    @Test func aFileNoLongerOpenGoesWithItsPages() throws {
        let sheets = ThreadSheetsModel()
        try apply(header("a.ts", file: "f1", version: "v1", pages: 1), to: sheets)
        try apply(page("a.ts", file: "f1", version: "v1", index: 0, rows: [(0, "a")]), to: sheets)
        try apply(header("b.ts", file: "f2", version: "v1", pages: 0), to: sheets)
        try apply(summary(open: ["b.ts"]), to: sheets)
        #expect(sheets.files["a.ts"] == nil)
        #expect(sheets.pages["f1"] == nil)
        #expect(sheets.files["b.ts"] != nil)
    }

    @Test func aWholeLineReplacesItsClippedRow() throws {
        let sheets = ThreadSheetsModel()
        try apply(header("a.ts", file: "f1", version: "v1", pages: 1), to: sheets)
        try apply(page("a.ts", file: "f1", version: "v1", index: 0, rows: [(0, "short"), (1, "cut")]), to: sheets)
        try apply("""
        {"type":"changes.line","threadId":"t","epoch":1,"file":"f1","path":"a.ts","version":"v1","row":{"i":1,"kind":"add","old":null,"new":2,"text":"cut and the rest","length":16,"clipped":false,"count":null}}
        """, to: sheets)
        let file = try #require(sheets.files["a.ts"])
        #expect(sheets.rows(file).map(\.text) == ["short", "cut and the rest"])
    }

    @Test func aCommentAnchorsToTheNewLineForAddedRowsAndTheOldForRemoved() {
        let added = ChangesRow(i: 0, kind: "add", old: nil, new: 7, text: "", length: 0, clipped: false, count: nil)
        let removed = ChangesRow(i: 1, kind: "del", old: 9, new: nil, text: "", length: 0, clipped: false, count: nil)
        let fold = ChangesRow(i: 2, kind: "fold", old: nil, new: nil, text: "", length: 0, clipped: false, count: 4)
        #expect(added.anchor?.side == "new" && added.anchor?.line == 7)
        #expect(removed.anchor?.side == "old" && removed.anchor?.line == 9)
        #expect(fold.anchor == nil)
        let picked = LineSelection(path: "a.ts", side: "new", start: 5, end: 8)
        #expect(picked.contains(added, in: "a.ts"))
        #expect(!picked.contains(added, in: "b.ts"))
        #expect(!picked.contains(removed, in: "a.ts"))
    }
}
