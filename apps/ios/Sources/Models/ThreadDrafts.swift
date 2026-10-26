import Foundation
import SwiftUI

/// Unsent composer words per thread, kept on this phone as the web keeps them per browser: going
/// back, opening another thread or killing the app gives the words back. Limits follow the web's
/// (`draftLimits` in `@ace/ui-core`): 50 drafts, the oldest falling off, each up to 100,000
/// characters. Only words are kept; attachments are staged files with their own lifetime.
@MainActor final class ThreadDrafts {
    static let limit = 50
    static let characters = 100_000
    private struct Entry: Codable, Sendable { let key: String; let text: String }
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

    /// Keep `text` as the newest draft; words that are only whitespace remove it.
    func save(_ text: String, for key: String) {
        var next = entries.filter { $0.key != key }
        if !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            next.append(Entry(key: key, text: String(text.prefix(Self.characters))))
        }
        if next.count > Self.limit { next.removeFirst(next.count - Self.limit) }
        guard next.map(\.key) != entries.map(\.key) || next.map(\.text) != entries.map(\.text) else { return }
        entries = next
        try? file.save(next)
    }
}

extension EnvironmentValues {
    /// Where thread composers keep unsent words; nil keeps them only while the thread is shown.
    @Entry var threadDrafts: ThreadDrafts?
}
