import Foundation

/// One message's Markdown blocks kept across updates, so a streaming delta parses only what it
/// changed. A row's text is a window on the message: a delta appends to it and, once the window
/// is full, drops some text from its front. The blocks between the first line where nothing is
/// open (after the front) and the last such line (before the end) are taken over unparsed; only
/// the first and last blocks are parsed again. The result always equals `Markdown.blocks`.
///
/// Each block's `id` is where it starts, counted from the start of the message rather than the
/// window, so a block keeps its identity (and its drawn text) while the window slides. Pure.
final class MarkdownStream {
    struct Block: Equatable, Identifiable, Sendable {
        let id: Int
        let block: MarkdownBlock
    }
    /// A line start where nothing is open, and how many blocks came before it.
    private struct Restart { let offset: Int; let blocks: Int }

    private(set) var text = ""
    private(set) var blocks: [Block] = []
    /// Bytes of the message before this window.
    private var origin = 0
    private var restarts: [Restart] = []
    /// Bytes the last update fed the parser: what it cost.
    private(set) var parsed = 0

    @discardableResult func update(_ new: String) -> [Block] {
        guard new != text || blocks.isEmpty else { return blocks }
        let old = (text: text, placed: blocks, restarts: restarts, origin: origin)
        let cut = Self.cut(from: old.text, to: new)
        // Text unrelated to the last (a different message) gets ids of its own.
        origin = cut.map { old.origin + $0 } ?? old.origin + old.text.utf8.count + 1
        // Old line starts where nothing was open, by where they now fall.
        var sync: [Int: Int] = [:]
        if let cut, let last = old.restarts.last {
            for (index, restart) in old.restarts.enumerated() where restart.offset >= cut && restart.offset <= last.offset {
                sync[restart.offset - cut] = index
            }
        }
        var parser = MarkdownParser()
        var found: [Restart] = []
        var offset = 0
        var fed = 0
        let utf8 = new.utf8
        var index = utf8.startIndex
        var spliced = false
        while true {
            if parser.isIdle {
                if !spliced, let at = sync[offset], let cut, let last = old.restarts.last {
                    // From here to the old text's last restart, the lines and so the blocks are
                    // the old ones.
                    spliced = true
                    let from = old.restarts[at], before = parser.blocks.count, shift = origin
                    found.append(contentsOf: old.restarts[at..<(old.restarts.count - 1)].map {
                        Restart(offset: $0.offset - cut, blocks: $0.blocks - from.blocks + before)
                    })
                    parser.adopt(old.placed[from.blocks..<last.blocks].map { PlacedBlock(start: $0.id - shift, block: $0.block) })
                    offset = last.offset - cut
                    index = utf8.index(utf8.startIndex, offsetBy: offset)
                    continue
                }
                found.append(Restart(offset: offset, blocks: parser.blocks.count))
            }
            let end = utf8[index...].firstIndex(of: 0x0A) ?? utf8.endIndex
            let line = new[index..<end]
            parser.feed(line, at: offset)
            let length = utf8.distance(from: index, to: end)
            fed += length + 1
            offset += length + 1
            guard end < utf8.endIndex else { break }
            index = utf8.index(after: end)
        }
        parsed = fed
        text = new
        restarts = found
        let shift = origin
        blocks = parser.finish().map { Block(id: $0.start + shift, block: $0.block) }
        return blocks
    }

    /// How many bytes `new` drops from the front of `old` before continuing it, or nil when it
    /// doesn't continue it.
    static func cut(from old: String, to new: String) -> Int? {
        if old.isEmpty { return 0 }
        let found: Int?? = old.utf8.withContiguousStorageIfAvailable { o -> Int? in
            let inner: Int?? = new.utf8.withContiguousStorageIfAvailable { n -> Int? in
                guard let ob = o.baseAddress, let nb = n.baseAddress else { return nil }
                if n.count >= o.count && memcmp(ob, nb, o.count) == 0 { return 0 }
                // Look for the start of `new` in `old`, then check the rest of `old` matches.
                let probe = min(32, n.count)
                guard probe > 0 else { return nil }
                var from = max(1, o.count - n.count)
                while from < o.count, let hit = memmem(ob + from, o.count - from, nb, probe) {
                    let at = ob.distance(to: hit.assumingMemoryBound(to: UInt8.self))
                    if memcmp(ob + at, nb, o.count - at) == 0 { return at }
                    from = at + 1
                }
                return nil
            }
            return inner ?? nil
        }
        return found ?? nil
    }
}
