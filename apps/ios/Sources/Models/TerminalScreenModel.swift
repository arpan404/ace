import Foundation
import Observation

struct TerminalOutputPatch: Decodable, Sendable {
    struct Event: Decodable, Sendable {
        let type: String
        let offset: Int?
        let endOffset: Int?
        let oldestOffset: Int?
        let nextOffset: Int?
        let data: String?
        let truncatedBefore: Bool?
        let message: String?
    }
    let id: String
    let event: Event
}

/// The watched terminal: canonical PTY byte offsets on the main thread (so replayed output is
/// shown once), and the emulator (`TerminalSession`) that parses it off the main thread.
@MainActor @Observable final class TerminalScreenModel {
    var streamId: String?
    var offset = 0
    var problem: String?
    var exited = false
    /// Bumps when the screen changes; views that only need words (title, mode) read it.
    private(set) var revision = 0
    @ObservationIgnored private(set) var session = TerminalSession()
    /// Device reports the program asked for (cursor position, attributes): sent as input.
    @ObservationIgnored var onReply: ((String) -> Void)?
    /// Columns and rows the screen was last fitted to, so a new stream starts at that size.
    @ObservationIgnored private var size = (columns: 80, rows: 24)

    /// Whether the program wants application cursor keys; key input encodes arrows for it.
    var applicationCursor: Bool { session.read { $0.modes.applicationCursor } }
    var bracketedPaste: Bool { session.read { $0.modes.bracketedPaste } }
    /// Every row of history and screen as text (copy, find, tests).
    var text: String { session.read { $0.text } }
    var title: String { _ = revision; return session.read { $0.title } }
    var fullScreen: Bool { _ = revision; return session.read { $0.usingAlternate } }

    func start(_ id: String) {
        streamId = id
        offset = 0
        problem = nil
        exited = false
        session = TerminalSession(columns: size.columns, rows: size.rows)
        revision += 1
    }

    /// Take one output event. Answers the new acknowledged offset (nil when the event is not for
    /// this stream); `parsed` runs once the emulator has drawn it, the moment to grant credit.
    @discardableResult
    func receive(_ patch: TerminalOutputPatch, parsed: (@MainActor @Sendable (Int) -> Void)? = nil) -> Int? {
        guard patch.id == streamId else { return nil }
        let event = patch.event
        switch event.type {
        case "data":
            problem = nil
            guard let start = event.offset, let end = event.endOffset, let data = event.data else { return nil }
            guard end > offset else { parsed?(offset); return offset }
            if event.truncatedBefore == true || start > offset { gap() }
            // Duplicate frames on reconnect are discarded by canonical PTY byte offsets.
            let fresh = start >= offset ? data : String(decoding: Array(data.utf8.dropFirst(offset - start)), as: UTF8.self)
            offset = end
            let stream = streamId
            session.feed(fresh) { [weak self] replies in
                guard let self, self.streamId == stream else { return }
                self.revision += 1
                if !replies.isEmpty { self.onReply?(replies) }
                parsed?(end)
            }
        case "resync":
            if let oldest = event.oldestOffset, oldest > offset {
                gap()
                offset = oldest
            }
            parsed?(offset)
        case "exit": exited = true
        case "problem": problem = event.message
        default: break
        }
        return offset
    }

    /// Fit the emulator to the view; answers whether the PTY should be told.
    func fit(columns: Int, rows: Int) -> Bool {
        guard columns != size.columns || rows != size.rows else { return false }
        size = (columns, rows)
        session.change { $0.resize(columns: columns, rows: rows) }
        return true
    }

    /// Clear terminal: history and screen go; the line the cursor is on stays.
    func clear() { session.change { $0.clearHistory() } }

    /// Wait for parsing (tests).
    func settle() { session.settle() }

    private func gap() {
        session.resetParser()
        session.feed("\r\n\u{1b}[0m[Earlier output unavailable]\r\n") { _ in }
    }
}
