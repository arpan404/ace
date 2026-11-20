import Foundation
import SwiftUI
import Testing
@testable import Ace

/// The Files search's Contents scope draws what the bridge's `files.contents` patch says: files
/// grouped with their trimmed lines, the tally while matches stream in, and never the rows of an
/// older query under a newer one.
@Suite @MainActor struct ContentSearchTests {
    private func patch(pattern: String, status: String, tally: String?, note: String? = nil, regex: Bool = false) throws -> FilesPatch {
        let json = """
        {"type":"files.contents","threadId":"t1",
         "query":{"pattern":"\(pattern)","matchCase":false,"wholeWord":false,"regex":\(regex)},
         "status":"\(status)","tally":\(tally.map { "\"\($0)\"" } ?? "null"),
         "note":\(note.map { "\"\($0)\"" } ?? "null"),"error":null,
         "files":[{"path":"src/relay/outbox.ts","name":"outbox.ts","folder":"src/relay","count":2,
           "lines":[{"key":"src/relay/outbox.ts:2","line":2,"column":3,"length":4,
             "parts":[{"text":"// ","match":false},{"text":"TODO","match":true},{"text":" flush","match":false}]}]}]}
        """
        return try JSONDecoder().decode(FilesPatch.self, from: Data(json.utf8))
    }

    @Test func streamedMatchesShowWithTheirTallyThenTheFinishedList() throws {
        let files = ThreadFilesModel()
        files.apply(try patch(pattern: "todo", status: "searching", tally: "2 results in 1 file"))
        let asked = ContentQuery(pattern: "todo")
        let streaming = try #require(files.contents["t1"])
        #expect(streaming.answers(asked))
        #expect(streaming.statusLine == "2 results in 1 file")
        #expect(streaming.files.first?.lines.first?.line == 2)

        files.apply(try patch(pattern: "todo", status: "done", tally: "2 results in 1 file",
                              note: "Showing the first 2,000 results. Narrow the search to see the rest."))
        let done = try #require(files.contents["t1"])
        #expect(done.status == "done" && done.note?.hasPrefix("Showing the first") == true)
    }

    @Test func anOlderQuerysRowsNeverAnswerANewerOne() throws {
        let files = ThreadFilesModel()
        files.apply(try patch(pattern: "tod", status: "searching", tally: "1 result in 1 file"))
        let found = try #require(files.contents["t1"])
        #expect(!found.answers(ContentQuery(pattern: "todo")))
        // A switch is part of the query too: turning regex on waits for its own answer.
        #expect(!found.answers(ContentQuery(pattern: "tod", regex: true)))
    }

    @Test func aSearchThatFoundNothingSaysSoAndOneStillRunningSaysItIsSearching() throws {
        let files = ThreadFilesModel()
        files.apply(try patch(pattern: "zzz", status: "done", tally: nil))
        #expect(files.contents["t1"]?.statusLine == "No results")
        files.apply(try patch(pattern: "zzz", status: "searching", tally: nil))
        #expect(files.contents["t1"]?.statusLine == "Searching…")
    }

    @Test func onlyTheMatchedTextIsEmphasisedInAPreview() throws {
        let line = try #require(try patch(pattern: "todo", status: "done", tally: nil)
            .contentsValue?.files.first?.lines.first)
        let preview = ContentSearch.preview(line.parts)
        let emphasised = preview.runs.filter { $0.inlinePresentationIntent == .stronglyEmphasized }
            .map { String(preview[$0.range].characters) }
        #expect(String(preview.characters) == "// TODO flush")
        #expect(emphasised == ["TODO"])
    }
}

private extension FilesPatch {
    var contentsValue: ContentSearch? { if case .contents(let search) = self { search } else { nil } }
}
