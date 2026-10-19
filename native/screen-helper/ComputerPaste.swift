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

/// What a rich document reads as plain text, keeping paragraph and list breaks. The HTML
/// comes from the model, so anything WebKit's importer would load is removed first.
func cuHTMLPlainText(_ html: String) -> String {
    let options: [NSAttributedString.DocumentReadingOptionKey: Any] = [.documentType: NSAttributedString.DocumentType.html, .characterEncoding: String.Encoding.utf8.rawValue]
    let text = (try? NSAttributedString(data: Data(cuOfflineHTML(html).utf8), options: options, documentAttributes: nil).string) ?? html
    return text.trimmingCharacters(in: .whitespacesAndNewlines)
}

/// What happened to the person's clipboard during a paste.
struct CUPasteReport {
    /// The person's clipboard was put back.
    var restored = false
    /// Types on the person's clipboard that could not be read, so could not be put back.
    var lostTypes: [String] = []
}

/// Pastes through the clipboard, then puts the person's clipboard back unless something else
/// wrote to it in the meantime. The whole transaction holds a lock shared by every helper
/// process, the saved clipboard stays on disk until it is restored (so an exit or a crash can
/// still restore it), and the agent's content is marked transient for clipboard managers.
@MainActor @discardableResult
func cuPaste(_ content: CUPasteContent, poster: CUPoster, application: AXUIElement, settler: CUSettler? = nil) async -> CUPasteReport {
    let lock = await CUFileLock.acquire(path: CUClipboard.lockPath, timeoutMs: 3_000)
    defer { withExtendedLifetime(lock) {} }
    let board = NSPasteboard.general
    let save = CUClipboard.snapshot(board, owner: getpid(), token: UUID().uuidString)
    var report = CUPasteReport(lostTypes: save.unreadable)
    if !save.unreadable.isEmpty {
        FileHandle.standardError.write(Data("ace-screen-helper: clipboard types not restorable: \(save.unreadable.joined(separator: ", "))\n".utf8))
    }
    let file = CUClipboard.persist(save)
    if let file { CUClipboard.pending = (save, file) }
    let before = cuFocusedTextLength(application)
    CUClipboard.writeAgentContent(content, token: save.token, to: board)
    // Layout-aware: the V key is elsewhere on non-US layouts.
    let paste = (try? cuParseChord("cmd+v")) ?? CUChord(code: 9, flags: .maskCommand, text: "v")
    if let item = cuMenuItem(for: paste, in: application) { AXUIElementPerformAction(item, "AXPress" as CFString) }
    else { poster.chord(paste) }
    await cuWaitForPasteConsumed(application, before: before, settler: settler)
    if CUClipboard.boardToken(board) == save.token {
        CUClipboard.restore(save, to: board)
        report.restored = true
    }
    if let file { try? FileManager.default.removeItem(at: file) }
    CUClipboard.pending = nil
    return report
}

/// Apps read the pasteboard while handling the paste, so it is consumed once the focused
/// text changes. When the change can't be seen (rich documents, web views), wait for the app
/// to go quiet instead, within a bound.
@MainActor func cuWaitForPasteConsumed(_ application: AXUIElement, before: Int?, settler: CUSettler?) async {
    let started = cuNow()
    if let before {
        while cuNow() - started < 700_000_000 {
            try? await Task.sleep(nanoseconds: 15_000_000)
            if let now = cuFocusedTextLength(application), now != before {
                try? await Task.sleep(nanoseconds: 30_000_000)
                return
            }
        }
        return
    }
    if let settler { await settler.settle(minimumMs: 120, quietMs: 120, maximumMs: 700) }
    else { try? await Task.sleep(nanoseconds: 300_000_000) }
}

/// Characters in the app's focused text element, nil when it has none.
func cuFocusedTextLength(_ application: AXUIElement) -> Int? {
    guard let focused = cuElementAttribute(application, "AXFocusedUIElement") else { return nil }
    return (cuFetchStatus(focused, ["AXNumberOfCharacters"]).0["AXNumberOfCharacters"] as? NSNumber)?.intValue
}

/// HTML with nothing that loads: elements that fetch or run (images, frames, media, scripts,
/// styles, stylesheet links, base and meta refresh) are removed, and resource attributes and
/// CSS `url()` are dropped. Link targets stay; they are text, never fetched.
func cuOfflineHTML(_ html: String) -> String {
    var text = html
    let paired = "script|style|iframe|frame|frameset|object|video|audio|svg|template|noscript"
    let replacements: [(String, String)] = [
        ("(?is)<(\(paired))\\b[^>]*>.*?</\\1\\s*>", ""),
        ("(?is)<(?:img|image|link|base|meta|embed|source|track|input|iframe|frame|object|video|audio|script|style|picture)\\b[^>]*>", ""),
        ("(?is)\\s(?:src|srcset|background|poster|data|lowsrc|dynsrc|formaction|xlink:href)\\s*=\\s*(?:\"[^\"]*\"|'[^']*'|[^\\s>]+)", ""),
        ("(?is)url\\s*\\([^)]*\\)", "none"),
        ("(?is)@import[^;]*;?", ""),
    ]
    for (pattern, replacement) in replacements {
        text = text.replacingOccurrences(of: pattern, with: replacement, options: .regularExpression)
    }
    return text
}
