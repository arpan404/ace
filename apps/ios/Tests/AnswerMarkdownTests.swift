import SwiftUI
import Testing
import UIKit
@testable import Ace

/// Answers read in the flavour the web reads them in (`AnswerMarkdown`), and their maths is
/// typeset: each formula, inline or display, in any of its delimiters, is drawn as an image in
/// the text rather than shown as TeX. (VoiceOver still reads the TeX, so the UI tests can't tell.)
@MainActor @Suite(.timeLimit(.minutes(1))) struct AnswerMarkdownTests {
    @Test func anAnswersInlineAndDisplayMathsAreTypesetInEveryDelimiter() async throws {
        let answer = """
        The hypotenuse follows from $a^2 + b^2 = c^2$, so

        $$c = \\sqrt{a^2 + b^2}$$

        and \\(x > 0\\), with

        \\[\\frac{a}{b}\\]
        """
        let formulas = try await typesetFormulas(in: answer, expecting: 4)
        #expect(formulas == 4)
    }

    /// Draws `text` as an answer does and counts the images in its text, waiting up to a few
    /// seconds for markit's renderer to reach `expecting`.
    private func typesetFormulas(in text: String, expecting: Int) async throws -> Int {
        let host = UIHostingController(rootView: AceMarkdown(text: text, flavor: AnswerMarkdown.flavor).frame(width: 360))
        let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 390, height: 844))
        window.rootViewController = host
        window.isHidden = false
        defer { window.isHidden = true }
        var found = 0
        for _ in 0..<60 {
            host.view.setNeedsLayout()
            host.view.layoutIfNeeded()
            found = Self.attachments(in: host.view)
            if found >= expecting { break }
            try await Task.sleep(for: .milliseconds(50))
        }
        return found
    }

    private static func attachments(in view: UIView) -> Int {
        var count = 0
        if let text = view as? UITextView {
            let all = NSRange(location: 0, length: text.attributedText.length)
            text.attributedText.enumerateAttribute(.attachment, in: all) { value, _, _ in if value != nil { count += 1 } }
        }
        return view.subviews.reduce(count) { $0 + attachments(in: $1) }
    }
}
