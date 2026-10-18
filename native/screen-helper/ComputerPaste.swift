import AppKit

/// Pasteboard content for one paste: rich formats carry HTML plus a plain-text fallback.
struct CUPasteContent: Equatable {
    let plain: String
    let html: String?
}

/// Turns the model's text into what goes on the pasteboard. Markdown becomes rich text so
/// documents keep headings, lists and links.
func cuPasteContent(_ text: String, format: String) throws -> CUPasteContent {
    switch format {
    case "text": return CUPasteContent(plain: text, html: nil)
    case "html": return CUPasteContent(plain: cuHTMLPlainText(text), html: text)
    case "markdown":
        let html = cuMarkdownHTML(text)
        return CUPasteContent(plain: cuHTMLPlainText(html), html: html)
    default: throw CUError("bad_action", "paste format is text, html or markdown.")
    }
}

/// What a rich document reads as plain text, keeping paragraph and list breaks.
func cuHTMLPlainText(_ html: String) -> String {
    let options: [NSAttributedString.DocumentReadingOptionKey: Any] = [.documentType: NSAttributedString.DocumentType.html, .characterEncoding: String.Encoding.utf8.rawValue]
    let text = (try? NSAttributedString(data: Data(html.utf8), options: options, documentAttributes: nil).string) ?? html
    return text.trimmingCharacters(in: .whitespacesAndNewlines)
}

/// Pastes through the clipboard, then puts the person's clipboard back unless something else
/// wrote to it in the meantime.
@MainActor func cuPaste(_ content: CUPasteContent, poster: CUPoster, application: AXUIElement) async {
    let board = NSPasteboard.general
    let saved: [[NSPasteboard.PasteboardType: Data]] = (board.pasteboardItems ?? []).map { item in
        var types: [NSPasteboard.PasteboardType: Data] = [:]
        for type in item.types { if let data = item.data(forType: type) { types[type] = data } }
        return types
    }
    board.clearContents()
    if let html = content.html { board.setString(html, forType: .html) }
    board.setString(content.plain, forType: .string)
    let ours = board.changeCount
    let paste = CUChord(code: 9, flags: .maskCommand, text: "v")
    if let item = cuMenuItem(for: paste, in: application) { AXUIElementPerformAction(item, "AXPress" as CFString) }
    else { poster.chord(paste) }
    try? await Task.sleep(nanoseconds: 400_000_000)
    guard board.changeCount == ours else { return }
    board.clearContents()
    let items = saved.map { types -> NSPasteboardItem in
        let item = NSPasteboardItem()
        for (type, data) in types { item.setData(data, forType: type) }
        return item
    }
    if !items.isEmpty { board.writeObjects(items) }
}
