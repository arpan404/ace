import Foundation

/// A terminal's raw output as it arrived, escapes and all, for exporting: at most `limit` bytes,
/// about the screen's scrollback. The oldest whole chunks go first (one chunk longer than the
/// limit is kept alone) and are let go of at once, so appending costs the chunk, never the whole
/// log, and memory stays near the limit however small or large the chunks. Web keeps the same
/// (`panels/terminal/raw-log.ts`). An export says at its top when older output was dropped.
struct TerminalRawLog {
    /// Starts an export that lost its beginning to the limit: styles reset (the cut may fall
    /// inside a colour or a sequence), then the words.
    static let droppedNotice = "\u{1b}[0m[Earlier output dropped: this log keeps only the most recent output]\r\n"

    /// Chunks in arrival order; a dropped chunk's slot is emptied at once and its place reused
    /// once enough slots are spent.
    private var chunks: [String?] = []
    private var head = 0
    /// Bytes held.
    private(set) var size = 0
    /// Older output was dropped to stay within the limit since the log was last cleared.
    private(set) var dropped = false
    let limit: Int

    init(limit: Int = 1_000_000) { self.limit = limit }

    var isEmpty: Bool { size == 0 }
    var text: String { chunks[head...].lazy.compactMap { $0 }.joined() }
    /// Bytes the stored chunks take, counted from the storage itself.
    var retained: Int { chunks.reduce(0) { $0 + ($1?.utf8.count ?? 0) } }

    mutating func append(_ data: String) {
        guard !data.isEmpty else { return }
        chunks.append(data)
        size += data.utf8.count
        while size > limit, chunks.count - head > 1 {
            size -= chunks[head]?.utf8.count ?? 0
            chunks[head] = nil
            head += 1
            dropped = true
        }
        // Reuse the spent slots now and then rather than shifting on every chunk.
        if head > 1024, head * 2 > chunks.count {
            chunks.removeFirst(head)
            head = 0
        }
    }

    mutating func clear() {
        chunks = []
        head = 0
        size = 0
        dropped = false
    }

    /// Write the log to a fresh `<name>.log` in the phone's temporary folder, for the share sheet.
    func export(named name: String) throws -> URL {
        let folder = FileManager.default.temporaryDirectory
            .appendingPathComponent("ace-terminal-logs/\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        let safe = String(name.map { "/\\:".contains($0) ? "-" : $0 }).trimmingCharacters(in: .whitespacesAndNewlines)
        let url = folder.appendingPathComponent("\(safe.isEmpty ? "terminal" : safe).log")
        try Data(((dropped ? Self.droppedNotice : "") + text).utf8).write(to: url, options: .atomic)
        return url
    }
}
