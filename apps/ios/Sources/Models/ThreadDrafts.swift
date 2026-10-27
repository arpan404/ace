import Foundation
import SwiftUI

/// Unsent composer words per thread, kept on this phone as the web keeps them per browser: going
/// back, opening another thread or killing the app gives the words back. Limits follow the web's
/// (`draftLimits` in `@ace/ui-core`): 50 drafts, the oldest falling off, each up to 100,000
/// characters. Words are kept with the references picked into them (`ComposerPicks`); attachments
/// are staged files with their own lifetime.
@MainActor final class ThreadDrafts {
    static let limit = 50
    static let characters = 100_000
    private struct Entry: Codable, Equatable, Sendable {
        let key: String
        let text: String
        /// Absent in drafts kept before references were.
        var picks: ComposerPicks?
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

    /// Keep `text` and its picks as the newest draft; words that are only whitespace remove it.
    func save(_ text: String, picks: ComposerPicks = ComposerPicks(), for key: String) {
        var next = entries.filter { $0.key != key }
        if !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            let kept = String(text.prefix(Self.characters))
            // Words cut short keep no picks: their places may be gone.
            next.append(Entry(key: key, text: kept, picks: picks.isEmpty || kept != text ? nil : picks))
        }
        if next.count > Self.limit { next.removeFirst(next.count - Self.limit) }
        guard next != entries else { return }
        entries = next
        try? file.save(next)
    }
}

extension EnvironmentValues {
    /// Where thread composers keep unsent words; nil keeps them only while the thread is shown.
    @Entry var threadDrafts: ThreadDrafts?
}
