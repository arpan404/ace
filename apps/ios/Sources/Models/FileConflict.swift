import Foundation

struct FileComparison: Decodable, Sendable {
    let rows: [ChangesRow]
    let finalNewlineChanged: Bool
}

struct FileMerge: Decodable, Sendable {
    enum Choice: Sendable { case mine, theirs }

    enum Chunk: Decodable, Sendable {
        case clean(String)
        case conflict(mine: String, theirs: String)

        private enum Key: String, CodingKey { case kind, text, mine, theirs }
        private enum Kind: String, Decodable { case clean, conflict }

        init(from decoder: any Decoder) throws {
            let fields = try decoder.container(keyedBy: Key.self)
            switch try fields.decode(Kind.self, forKey: .kind) {
            case .clean: self = .clean(try fields.decode(String.self, forKey: .text))
            case .conflict:
                self = .conflict(mine: try fields.decode(String.self, forKey: .mine),
                                 theirs: try fields.decode(String.self, forKey: .theirs))
            }
        }
    }

    let disk: FileContent
    let chunks: [Chunk]

    struct Overlap: Identifiable {
        let id: Int
        let mine: String
        let theirs: String
    }

    var overlaps: [Overlap] {
        chunks.enumerated().compactMap { index, chunk in
            guard case .conflict(let mine, let theirs) = chunk else { return nil }
            return Overlap(id: index, mine: mine, theirs: theirs)
        }
    }

    /// All overlapping chunks need a choice before the result can replace the editor's draft.
    func resolved(_ choices: [Int: Choice]) -> String? {
        var result = ""
        for (index, chunk) in chunks.enumerated() {
            switch chunk {
            case .clean(let text): result += text
            case .conflict(let mine, let theirs):
                guard let choice = choices[index] else { return nil }
                result += choice == .mine ? mine : theirs
            }
        }
        return result
    }
}
