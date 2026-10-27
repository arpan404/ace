import SwiftUI
import UIKit

/// A finished answer's extras from the bridge (`bridge/native-rich.ts`): its math as text, a fenced
/// block's grammar colours or diff lines. Asked once per text and kept, so scrolling back never
/// asks again and a row never changes twice. Never asked while text streams.
@MainActor final class MarkdownRich {
    struct Code: Decodable, Equatable {
        struct Line: Decodable, Equatable { let kind: String; let text: String }
        let diff: [Line]?
        let colours: [[String]]
        let runs: [Int]
    }
    /// The answer with each formula marked where it sits, and the formulas (`mathSpans`).
    struct Prose: Decodable, Equatable {
        let text: String
        let math: [MathSpan]
    }
    private let model: ClientModel
    private var prose: [String: Prose] = [:]
    private var code: [String: Code] = [:]
    private static let kept = 300
    init(model: ClientModel) { self.model = model }

    func knownProse(_ text: String) -> Prose? { prose[text] }
    func knownCode(_ language: String, _ text: String) -> Code? { code[language + "\u{0}" + text] }

    /// The text with its formulas marked; nil when it holds none or the read fails.
    func prose(_ text: String) async -> Prose? {
        if let known = prose[text] { return known }
        guard text.contains("$") || text.contains("\\(") || text.contains("\\[") else { return nil }
        guard let read = try? await model.service(["type": "native.rich", "kind": "prose", "text": text], as: Prose.self),
              !read.math.isEmpty else { return nil }
        keep(&prose, text, read)
        return read
    }
    func code(_ language: String, _ text: String) async -> Code? {
        let key = language + "\u{0}" + text
        if let known = code[key] { return known }
        guard !language.isEmpty, text.utf16.count <= 64 * 1024,
              let read = try? await model.service(["type": "native.rich", "kind": "code", "language": language, "text": text], as: Code.self)
        else { return nil }
        keep(&code, key, read)
        return read
    }
    private func keep<Value>(_ store: inout [String: Value], _ key: String, _ value: Value) {
        if store.count >= Self.kept { store.removeAll(keepingCapacity: true) }
        store[key] = value
    }

    /// The code with its colours, in the appearance's own shade of each.
    static func coloured(_ text: String, _ code: Code) -> AttributedString {
        let string = NSMutableAttributedString(string: text)
        let palette = code.colours.map { pair in
            let light = UIColor(hex: pair.first ?? ""), dark = UIColor(hex: pair.last ?? "")
            return UIColor { $0.userInterfaceStyle == .dark ? dark : light }
        }
        var at = 0
        var index = 0
        let length = (text as NSString).length
        while index + 1 < code.runs.count {
            let run = code.runs[index], colour = code.runs[index + 1]
            if colour > 0, colour <= palette.count, at + run <= length {
                string.addAttribute(.foregroundColor, value: palette[colour - 1], range: NSRange(location: at, length: run))
            }
            at += run
            index += 2
        }
        return (try? AttributedString(string, including: \.uiKit)) ?? AttributedString(text)
    }
}

extension EnvironmentValues {
    /// Where finished answers read their extras; nil draws Markdown plain.
    @Entry var markdownRich: MarkdownRich? = nil
    /// The Markdown on screen has stopped streaming: its code may be coloured.
    @Entry var markdownSettled = false
}
