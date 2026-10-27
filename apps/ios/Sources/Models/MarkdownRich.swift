import CryptoKit
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
    struct Prose: Codable, Sendable, Equatable {
        let text: String
        let math: [MathSpan]
    }
    private let model: ClientModel
    /// Kept by a digest of the text they were read for, costed in bytes, so a long thread's
    /// answers never pile up and nothing is thrown away all at once.
    private let prose = NSCache<NSString, Box<Prose>>()
    private let code = NSCache<NSString, Box<Code>>()
    private final class Box<Value> { let value: Value; init(_ value: Value) { self.value = value } }
    init(model: ClientModel) {
        self.model = model
        prose.totalCostLimit = 4 * 1024 * 1024
        code.totalCostLimit = 4 * 1024 * 1024
    }

    private static func digest(_ parts: String...) -> NSString {
        var hash = SHA256()
        for part in parts { hash.update(data: Data(part.utf8)); hash.update(data: Data([0])) }
        return hash.finalize().map { String(format: "%02x", $0) }.joined() as NSString
    }

    func knownProse(_ text: String) -> Prose? { prose.object(forKey: Self.digest(text))?.value }
    func knownCode(_ language: String, _ text: String) -> Code? { code.object(forKey: Self.digest(language, text))?.value }

    /// The text with its formulas marked; nil when it holds none or the read fails.
    func prose(_ text: String) async -> Prose? {
        let key = Self.digest(text)
        if let known = prose.object(forKey: key) { return known.value }
        guard text.contains("$") || text.contains("\\(") || text.contains("\\[") else { return nil }
        guard let read = try? await model.service(["type": "native.rich", "kind": "prose", "text": text], as: Prose.self),
              !read.math.isEmpty else { return nil }
        let bytes = read.text.utf8.count + read.math.reduce(0) { $0 + $1.tex.utf8.count + $1.text.utf8.count }
        prose.setObject(Box(read), forKey: key, cost: bytes)
        return read
    }
    func code(_ language: String, _ text: String) async -> Code? {
        let key = Self.digest(language, text)
        if let known = code.object(forKey: key) { return known.value }
        guard !language.isEmpty, text.utf16.count <= 64 * 1024,
              let read = try? await model.service(["type": "native.rich", "kind": "code", "language": language, "text": text], as: Code.self)
        else { return nil }
        let bytes = read.runs.count * 8 + (read.diff ?? []).reduce(0) { $0 + $1.text.utf8.count + 16 }
        code.setObject(Box(read), forKey: key, cost: bytes)
        return read
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
