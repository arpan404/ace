import SwiftUI

/// What the person asked for in the Contents search: the text and the three switches the web's
/// Search view has.
struct ContentQuery: Codable, Sendable, Hashable {
    var pattern = ""
    var matchCase = false
    var wholeWord = false
    var regex = false
    var wire: [String: Any] { ["pattern": pattern, "matchCase": matchCase, "wholeWord": wholeWord, "regex": regex] }
}

/// A thread's search in file contents as the bridge sends it (`files.contents`,
/// `bridge/FILES-CONTRACT.md` §3d): files in the order found with their lines already trimmed
/// so the first match shows, and the sentences the list says.
struct ContentSearch: Decodable, Sendable, Equatable {
    struct Part: Decodable, Sendable, Equatable {
        let text: String
        let match: Bool
    }
    struct Line: Decodable, Sendable, Equatable, Identifiable {
        let key: String
        let line: Int
        /// The first match's UTF-16 column and length in the line.
        let column: Int
        let length: Int
        let parts: [Part]
        var id: String { key }
    }
    struct File: Decodable, Sendable, Equatable, Identifiable {
        let path: String
        let name: String
        let folder: String
        let count: Int
        let lines: [Line]
        var id: String { path }
    }
    let threadId: String
    let query: ContentQuery
    /// `idle`, `searching`, `done` or `failed`.
    let status: String
    /// "12 results in 3 files" once anything is found.
    let tally: String?
    /// Says the list was cut at the match limit.
    let note: String?
    /// Why the search failed, as one sentence.
    let error: String?
    let files: [File]

    /// Whether this answers `query`: rows of an older query never show under a newer one.
    func answers(_ query: ContentQuery) -> Bool { self.query == query }

    /// The line under the results: the tally, or what the search is doing instead.
    var statusLine: String? {
        switch status {
        case "searching": tally ?? "Searching…"
        case "done": tally ?? "No results"
        default: nil
        }
    }

    /// A line's preview with every match in full ink and emphasised, the rest muted.
    @MainActor static func preview(_ parts: [Part]) -> AttributedString {
        var out = AttributedString()
        for part in parts {
            var piece = AttributedString(part.text)
            piece.foregroundColor = part.match ? AceTheme.Colours.foreground : AceTheme.Colours.mutedForeground
            if part.match {
                piece.inlinePresentationIntent = .stronglyEmphasized
                piece.backgroundColor = AceTheme.Colours.foreground.opacity(0.18)
            }
            out += piece
        }
        return out
    }
}
