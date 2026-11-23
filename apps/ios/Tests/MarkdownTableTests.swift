import SwiftUI
import Testing
import UIKit
@testable import Ace

/// A table in an answer fits the row whenever its words do: short columns keep their width,
/// prose wraps, code breaks inside its paths. Only a table whose words alone are wider than the
/// row scrolls sideways, inside the row.
@MainActor @Suite(.timeLimit(.minutes(1))) struct MarkdownTableTests {
    @Test func columnsThatFitKeepTheirNaturalWidths() {
        #expect(MarkdownTableColumns.widths(natural: [80, 200.4], minimum: [40, 60], available: 400) == [80, 201])
    }

    @Test func proseShrinksToTheRoomLeftWhileShortLabelsKeepTheirWidth() {
        #expect(MarkdownTableColumns.widths(natural: [70, 900], minimum: [50, 90], available: 400) == [70, 330])
    }

    @Test func twoProseColumnsShareTheRoomByTheirTextWithinTheCap() {
        // By text alone the second would take 320 of 400; it stops at 60%, the first gets the rest.
        #expect(MarkdownTableColumns.widths(natural: [400, 1600], minimum: [50, 50], available: 400) == [160, 240])
    }

    @Test func aTableWhoseMinimumsFitFillsTheRoomExactly() {
        let widths = MarkdownTableColumns.widths(natural: [300, 300, 300], minimum: [130, 130, 130], available: 400)
        #expect(widths.reduce(0, +) == 400)
        #expect(widths.allSatisfy { $0 >= 130 })
    }

    @Test func aColumnAtItsNaturalWidthGivesRoomBackToOneHeldAtItsMinimum() {
        #expect(MarkdownTableColumns.widths(natural: [50, 200], minimum: [10, 60], available: 100) == [40, 60])
    }

    @Test func onlyMinimumsWiderThanTheRoomMakeTheTableScroll() {
        let widths = MarkdownTableColumns.widths(natural: [300, 300, 300], minimum: [150, 150, 150], available: 400)
        #expect(widths.reduce(0, +) > 400)
        #expect(widths.allSatisfy { $0 >= 150 && $0 <= 300 })
    }

    @Test func inlineCodeInACellBreaksAfterItsSeparatorsAndProseIsLeftAlone() {
        var code = AttributedString("apps/ios/project.yml:35")
        code[AttributeScopes.UIKitAttributes.BackgroundColorAttribute.self] = .gray
        let text = AttributedString("see ") + code + AttributedString(" now.")
        let broken = String(MarkdownTable.breakable(text).characters)
        #expect(broken == "see apps/\u{200B}ios/\u{200B}project.\u{200B}yml:\u{200B}35 now.")
    }

    @Test func aLabelAndProseTableFitsTheRowWithoutScrolling() async throws {
        let answer = """
        | Child | What it's fixing |
        | --- | --- |
        | Tables | Wide tables in answers run past the screen. This child lays them out to fit, wrapping the prose column. |
        | Code | `apps/ios/project.yml:35` and `cloud.acehq.dev` ran off the edge of the text instead of wrapping inside it. |
        """
        let views = try await laidOut(answer, width: 360) { views in
            views.contains { ($0 as? UIScrollView).map { $0.bounds.width > 0 && $0.contentSize.width > 0 } ?? false }
        }
        let scrollers = views.compactMap { $0 as? UIScrollView }
        #expect(!scrollers.isEmpty)
        #expect(scrollers.allSatisfy {
            $0.bounds.width > 0 && $0.bounds.width <= 360
                && $0.contentSize.width > 0 && $0.contentSize.width <= $0.bounds.width + 1
        })
    }

    @Test func aTableOfLongUnbreakableWordsScrollsInsideTheRow() async throws {
        let answer = """
        | One | Two | Three |
        | --- | --- | --- |
        | Supercalifragilisticexpialidocious | Antidisestablishmentarianism | Pneumonoultramicroscopicsilicovolcanoconiosis |
        """
        let views = try await laidOut(answer, width: 360) { views in
            views.contains { ($0 as? UIScrollView).map { $0.contentSize.width > $0.bounds.width + 1 } ?? false }
        }
        let table = try #require(views.compactMap { $0 as? UIScrollView }.first { $0.contentSize.width > $0.bounds.width + 1 })
        #expect(table.bounds.width <= 360)
        #expect(!views.contains { $0.accessibilityIdentifier == "markit-table" })
    }

    @Test func mathInACellIsDrawnAsItsFormulaAndReadAsItsSource() throws {
        let table = MarkdownTable(source: "| Term | Value |\n| --- | --- |\n| Energy | $E = mc^2$ |",
                                  flavor: AnswerMarkdown.flavor, theme: AceMarkdownTheme.current(), traits: Self.traits)
        let cell = try #require(table.cells.first { $0.row == 1 && $0.column == 1 })
        #expect(cell.hasMath)
        #expect(cell.spoken.contains("E = mc^2"))
        // No TeX is left in the cell's own text.
        let words = cell.runs.compactMap { if case .text(let text) = $0 { String(text.characters) } else { nil } }.joined()
        #expect(!words.contains("mc^2"))
    }

    @Test func textAroundAFormulaKeepsItsWordsWhereMarkitWritesThemDifferently() throws {
        // An escaped pipe and an entity are shorter drawn than written: the cuts must not shift.
        let table = MarkdownTable(source: "| Term | Value |\n| --- | --- |\n| a \\| b &amp; c | before $x^2$ after &lt;end&gt; |",
                                  flavor: AnswerMarkdown.flavor, theme: AceMarkdownTheme.current(), traits: Self.traits)
        let cell = try #require(table.cells.first { $0.row == 1 && $0.column == 1 })
        let shape = cell.runs.map { run in
            switch run {
            case .text(let text): String(text.characters).replacingOccurrences(of: "\u{200B}", with: "")
            case .math: "<formula>"
            }
        }
        #expect(shape == ["before ", "<formula>", " after <end>"])
    }

    @Test func aFormulaInACellIsDrawnAgainInDarkInk() throws {
        let source = "| Term |\n| --- |\n| $x^2$ |"
        let reader = MarkdownTableReader()
        func formula(_ style: UIUserInterfaceStyle) throws -> Data {
            let traits = Self.traits.modifyingTraits { $0.userInterfaceStyle = style }
            let table = reader.table(source: source, flavor: AnswerMarkdown.flavor, theme: AceMarkdownTheme.current(), traits: traits)
            let cell = try #require(table.cells.first { $0.row == 1 })
            let image = try #require(cell.runs.compactMap { if case .math(let image, _) = $0 { image } else { nil } }.first)
            return try #require(image.pngData())
        }
        #expect(try formula(.light) != formula(.dark))
    }

    @Test func aTableReadRowByRowAsItArrivesHasTheCellsOfReadingItWhole() {
        let answer = "| Area | State |\n| --- | :-: |\n| Recording | `done` |\n| Replay | not **started** |\n| [Plan][p] | $x^2$ |\n\n[p]: https://example.com"
        let reader = MarkdownTableReader()
        let theme = AceMarkdownTheme.current()
        var grown = ""
        for character in answer {
            grown.append(character)
            let streamed = reader.table(source: grown, flavor: AnswerMarkdown.flavor, theme: theme, traits: Self.traits)
            let whole = MarkdownTable(source: grown, flavor: AnswerMarkdown.flavor, theme: theme, traits: Self.traits)
            #expect(streamed.rows == whole.rows, "at \(grown.count)")
            #expect(streamed.natural == whole.natural && streamed.minimum == whole.minimum, "at \(grown.count)")
            #expect(streamed.cells.map { "\($0.row),\($0.column),\($0.header),\($0.spoken)" }
                == whole.cells.map { "\($0.row),\($0.column),\($0.header),\($0.spoken)" }, "at \(grown.count)")
        }
    }

    private static let traits = UITraitCollection(preferredContentSizeCategory: .large)

    /// Draws `text` as an answer at `width` and returns its views once `ready` holds for them.
    private func laidOut(_ text: String, width: CGFloat, ready: ([UIView]) -> Bool) async throws -> [UIView] {
        let host = UIHostingController(rootView: AceMarkdown(text: text, flavor: AnswerMarkdown.flavor).frame(width: width))
        let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 390, height: 844))
        window.rootViewController = host
        window.isHidden = false
        defer { window.isHidden = true }
        var views: [UIView] = []
        for _ in 0..<40 {
            host.view.setNeedsLayout()
            host.view.layoutIfNeeded()
            views = Self.views(in: host.view)
            if ready(views) { break }
            try await Task.sleep(for: .milliseconds(50))
        }
        return views
    }

    private static func views(in view: UIView) -> [UIView] {
        [view] + view.subviews.flatMap { views(in: $0) }
    }
}
