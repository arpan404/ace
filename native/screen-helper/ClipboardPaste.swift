import AppKit

struct ClipboardItem: Equatable { let types: [String: Data] }
@MainActor struct ClipboardBoard {
    let change: () -> Int
    let read: () throws -> [ClipboardItem]
    let write: ([ClipboardItem]) -> Bool
    static let live = ClipboardBoard(change: { NSPasteboard.general.changeCount }, read: {
        var bytes = 0
        return try (NSPasteboard.general.pasteboardItems ?? []).map { item in
            var types: [String: Data] = [:]
            for type in item.types {
                guard let data = item.data(forType: type) else { throw HelperError("Cannot preserve clipboard representation", code: "not_supported") }
                bytes += data.count
                guard bytes <= 8 * 1024 * 1024 else { throw HelperError("Clipboard exceeds preservation budget", code: "busy") }
                types[type.rawValue] = data
            }
            return ClipboardItem(types: types)
        }
    }, write: { items in
        let board = NSPasteboard.general
        board.clearContents()
        if items.isEmpty { return true }
        return board.writeObjects(items.map { item in
            let result = NSPasteboardItem()
            for (type, data) in item.types { result.setData(data, forType: NSPasteboard.PasteboardType(type)) }
            return result
        })
    })
}
@MainActor func clipboardPaste(_ text: String, post: () throws -> Void) async throws {
    try await clipboardPaste(text, board: .live, wait: { try await Task.sleep(nanoseconds: 500_000_000) }, post: post)
}
@MainActor func clipboardPaste(_ text: String, board: ClipboardBoard, wait: () async throws -> Void, post: () throws -> Void) async throws {
    let initial = board.change(), saved = try board.read()
    guard saved.reduce(0, { $0 + $1.types.values.reduce(0, { $0 + $1.count }) }) <= 8 * 1024 * 1024 else { throw HelperError("Clipboard exceeds preservation budget", code: "busy") }
    guard initial == board.change() else { throw HelperError("Clipboard changed while preserving it", code: "clipboard_changed") }
    guard board.write([ClipboardItem(types: [NSPasteboard.PasteboardType.string.rawValue: Data(text.utf8)])]) else {
        _ = board.write(saved)
        throw HelperError("Cannot prepare paste clipboard", code: "not_supported")
    }
    let ownChange = board.change()
    var failure: Error?
    do { try post(); try await wait() } catch { failure = error }
    guard ownChange == board.change() else { throw HelperError("Clipboard changed during paste; human clipboard retained", code: "clipboard_changed") }
    guard board.write(saved) else { throw HelperError("Clipboard restoration failed", code: "internal") }
    if let failure { throw failure }
}
