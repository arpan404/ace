import SwiftUI
import Testing
import UIKit
@testable import Ace

/// A table in an answer is ace's own: as wide as its columns need, in a scroller no wider than
/// the row, so the columns past the screen's edge slide into view instead of being cut off.
@MainActor @Suite(.timeLimit(.minutes(1))) struct MarkdownTableTests {
    @Test func aColumnIsAsWideAsItsWidestCellUpToTheLimit() {
        let widths = MarkdownTableGrid.columnWidths(
            cells: [(column: 0, ideal: 60.2), (column: 0, ideal: 90), (column: 1, ideal: 900), (column: 1, ideal: 30)],
            columns: 2, limit: 300, floor: 44)
        #expect(widths == [90, 300])
    }

    @Test func anEmptyColumnStillTakesTheNarrowestWidth() {
        let widths = MarkdownTableGrid.columnWidths(cells: [(column: 0, ideal: 10), (column: 5, ideal: 80)], columns: 3, limit: 300, floor: 44)
        #expect(widths == [44, 44, 44])
    }

    @Test func aWideTableScrollsSidewaysInsideTheRowInsteadOfRunningPastIt() async throws {
        let answer = """
        Where things stand:

        | Area | main today |
        | --- | --- |
        | Recording | `packages/browser/src/recording.ts` writes every frame the page paints, then hands them to the encoder |
        | Replay | Nothing reads the recording back yet, so a replay only shows its first frame and stops there |

        That is all for now.
        """
        let width: CGFloat = 360
        let host = UIHostingController(rootView: AceMarkdown(text: answer, flavor: AnswerMarkdown.flavor).frame(width: width))
        let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 390, height: 844))
        window.rootViewController = host
        window.isHidden = false
        defer { window.isHidden = true }
        var scroller: UIScrollView?
        for _ in 0..<40 {
            host.view.setNeedsLayout()
            host.view.layoutIfNeeded()
            scroller = Self.views(in: host.view).compactMap { $0 as? UIScrollView }.first { $0.contentSize.width > $0.bounds.width + 1 }
            if scroller != nil { break }
            try await Task.sleep(for: .milliseconds(50))
        }
        let table = try #require(scroller)
        #expect(table.bounds.width <= width)
        #expect(table.contentSize.width > width)
        // The prose around it is still markit's, and markit draws no table of its own.
        #expect(Self.views(in: host.view).contains { $0 is UITextView })
        #expect(!Self.views(in: host.view).contains { $0.accessibilityIdentifier == "markit-table" })
    }

    private static func views(in view: UIView) -> [UIView] {
        [view] + view.subviews.flatMap { views(in: $0) }
    }
}
