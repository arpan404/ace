import Foundation
import os

/// One terminal's emulator, shared between a background parsing queue and the main thread's
/// renderer. Output is parsed off the main thread in short slices, so drawing never waits more
/// than one slice for the lock however fast the program prints.
final class TerminalSession: @unchecked Sendable {
    private let lock = NSLock()
    private var parser = TerminalParser()
    private var screen: TerminalScreen
    private let queue = DispatchQueue(label: "app.ace.terminal.parse", qos: .userInitiated)
    private var notifyScheduled = false
    /// Runs on the main thread at most once per batch of output, when the screen changed.
    @MainActor var onChange: (() -> Void)?
    private static let slice = 4_096
    static let signposts = OSLog(subsystem: "app.ace.ios", category: "terminal")

    init(columns: Int = 80, rows: Int = 24, scrollback: Int = 5_000) {
        screen = TerminalScreen(columns: columns, rows: rows, scrollback: scrollback)
    }

    /// Parse `text` on the parsing queue; `done` gets the device reports it asked for, on main.
    func feed(_ text: String, done: @escaping @MainActor @Sendable (String) -> Void) {
        queue.async { [self] in
            let replies = parse(text)
            scheduleNotify()
            DispatchQueue.main.async { MainActor.assumeIsolated { done(replies) } }
        }
    }

    /// Parse now, on the caller's thread (tests and benchmarks). Answers the device reports.
    @discardableResult func feedNow(_ text: String) -> String { queue.sync { parse(text) } }

    /// Wait until everything fed so far is parsed.
    func settle() { queue.sync {} }

    /// Read the screen under the lock. Keep `body` short: it holds up parsing.
    func read<T>(_ body: (TerminalScreen) -> T) -> T {
        lock.lock()
        defer { lock.unlock() }
        return body(screen)
    }

    /// Change the screen in order with parsing (resize, clear).
    func change(_ body: @escaping @Sendable (inout TerminalScreen) -> Void) {
        queue.async { [self] in
            lock.lock()
            body(&screen)
            lock.unlock()
            scheduleNotify()
        }
    }

    /// A gap in the output: a sequence cut by it must not swallow what follows.
    func resetParser() { queue.async { [self] in lock.lock(); parser.reset(); lock.unlock() } }

    private func parse(_ text: String) -> String {
        let id = OSSignpostID(log: Self.signposts)
        os_signpost(.begin, log: Self.signposts, name: "terminal.parse", signpostID: id, "%d", text.utf8.count)
        defer { os_signpost(.end, log: Self.signposts, name: "terminal.parse", signpostID: id) }
        var replies = ""
        var rest = Substring(text).unicodeScalars
        // Each hold of the lock parses at most a slice, and stops early once the screen has done
        // a slice's worth of work, so hostile output (huge scrolls, screen fills) never keeps
        // the renderer waiting.
        while !rest.isEmpty {
            let end = rest.index(rest.startIndex, offsetBy: Self.slice, limitedBy: rest.endIndex) ?? rest.endIndex
            lock.lock()
            screen.work = 0
            let stopped = parser.feed(rest[..<end], into: &screen)
            if !screen.replies.isEmpty {
                replies += screen.replies
                screen.replies = ""
            }
            lock.unlock()
            rest = rest[stopped...]
        }
        return replies
    }

    private func scheduleNotify() {
        lock.lock()
        let schedule = !notifyScheduled
        notifyScheduled = true
        lock.unlock()
        guard schedule else { return }
        DispatchQueue.main.async { [self] in
            lock.lock()
            notifyScheduled = false
            lock.unlock()
            MainActor.assumeIsolated { onChange?() }
        }
    }
}
