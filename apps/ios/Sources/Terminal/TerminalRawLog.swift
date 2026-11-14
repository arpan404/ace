import Foundation

/// A terminal's raw output as it arrived, escapes and all, for exporting: at most `limit` bytes,
/// about the screen's scrollback. The oldest whole chunks go first (one chunk longer than the
/// limit is kept alone), so appending costs the chunk, never the whole log. Web keeps the same
/// (`panels/terminal/raw-log.ts`).
struct TerminalRawLog {
    private var chunks: [String] = []
    private var head = 0
    private(set) var size = 0
    let limit: Int

    init(limit: Int = 1_000_000) { self.limit = limit }

    var isEmpty: Bool { size == 0 }
    var text: String { chunks[head...].joined() }

    mutating func append(_ data: String) {
        guard !data.isEmpty else { return }
        chunks.append(data)
        size += data.utf8.count
        while size > limit, chunks.count - head > 1 {
            size -= chunks[head].utf8.count
            head += 1
        }
        // Drop the consumed prefix now and then rather than shifting on every chunk.
        if head > 1024, head * 2 > chunks.count {
            chunks.removeFirst(head)
            head = 0
        }
    }

    mutating func clear() {
        chunks = []
        head = 0
        size = 0
    }

    /// Write the log to a fresh `<name>.log` in the phone's temporary folder, for the share sheet.
    func export(named name: String) throws -> URL {
        let folder = FileManager.default.temporaryDirectory
            .appendingPathComponent("ace-terminal-logs/\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        let safe = String(name.map { "/\\:".contains($0) ? "-" : $0 }).trimmingCharacters(in: .whitespacesAndNewlines)
        let url = folder.appendingPathComponent("\(safe.isEmpty ? "terminal" : safe).log")
        try Data(text.utf8).write(to: url, options: .atomic)
        return url
    }
}
