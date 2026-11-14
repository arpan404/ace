import Foundation
import SwiftUI

/// Unsent composer words per thread, kept on this phone as the web keeps them per browser: going
/// back, opening another thread or killing the app gives the words back. Limits follow the web's
/// (`draftLimits` in `@ace/ui-core`): 50 drafts, the oldest falling off, each up to 100,000
/// characters. Words are kept with the references picked into them (`ComposerPicks`) and the
/// quotes the next message replies to (`DraftQuote`, from the bridge); attachments are staged files
/// with their own lifetime.
@MainActor final class ThreadDrafts {
    static let limit = 50
    static let characters = 100_000
    private struct Entry: Codable, Equatable, Sendable {
        let key: String
        let text: String
        /// Absent in drafts kept before references were.
        var picks: ComposerPicks?
        /// What the next message replies to; absent when nothing is quoted.
        var quotes: [DraftQuote]?
    }
    private let file: DraftFile<[Entry]>
    /// Least recently written first.
    private var entries: [Entry]

    init(url: URL) {
        file = DraftFile(url: url)
        entries = file.load() ?? []
    }
    /// One machine's thread: thread ids are only unique per machine.
    nonisolated static func key(hostId: String, threadId: String) -> String { "\(hostId)\u{0}\(threadId)" }

    func text(for key: String) -> String { entries.last { $0.key == key }?.text ?? "" }
    func picks(for key: String) -> ComposerPicks { entries.last { $0.key == key }?.picks ?? ComposerPicks() }
    func quotes(for key: String) -> [DraftQuote] { entries.last { $0.key == key }?.quotes ?? [] }

    /// Keep `text` and its picks as the newest draft, with the quotes it already holds; words that
    /// are only whitespace leave only the quotes, and nothing when there are none.
    func save(_ text: String, picks: ComposerPicks = ComposerPicks(), for key: String) {
        let quotes = entries.last { $0.key == key }?.quotes
        var next = entries.filter { $0.key != key }
        if !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            let kept = String(text.prefix(Self.characters))
            // Words cut short keep no picks: their places may be gone.
            next.append(Entry(key: key, text: kept, picks: picks.isEmpty || kept != text ? nil : picks, quotes: quotes))
        } else if let quotes {
            next.append(Entry(key: key, text: "", quotes: quotes))
        }
        write(next)
    }
    /// Keep the quotes the bridge holds for the next message beside the words; none leaves only the
    /// words, and nothing when there are none either.
    func save(quotes: [DraftQuote], for key: String) {
        let held = entries.last { $0.key == key }
        var next = entries.filter { $0.key != key }
        let text = held?.text ?? ""
        if !quotes.isEmpty || !text.isEmpty {
            next.append(Entry(key: key, text: text, picks: held?.picks, quotes: quotes.isEmpty ? nil : quotes))
        }
        write(next)
    }
    private func write(_ entries: [Entry]) {
        var next = entries
        if next.count > Self.limit { next.removeFirst(next.count - Self.limit) }
        guard next != self.entries else { return }
        self.entries = next
        try? file.save(next)
    }
}

/// A quote on the next message as the bridge holds it whole (`bridge/thread-quotes.ts`), kept with
/// the draft so a relaunch gives it back (`quote.restore`).
struct DraftQuote: Codable, Sendable, Equatable {
    let id: String
    let text: String
    let before: String
    let after: String
    var json: [String: Any] { ["id": id, "text": text, "before": before, "after": after] }
}

extension EnvironmentValues {
    /// Where thread composers keep unsent words; nil keeps them only while the thread is shown.
    @Entry var threadDrafts: ThreadDrafts?
}
