import Foundation
import Testing
@testable import Ace

/// The iPad side panel as the shared rules send it (`bridge/workspace.ts`).
@Suite struct ThreadPanelsTests {
    @Test func aVisualizationTabNamesThePageItShowsAndDrawsAsAVisualization() throws {
        let json = """
        {"scope":"t1","open":true,"active":"visualization:page-1","size":400,"canReopen":false,
         "tabs":[{"key":"changes","kind":"changes","id":"changes","title":"Changes","pinned":true},
                 {"key":"visualization:page-1","kind":"visualization","id":"page-1","title":"Revenue by month","pinned":false}],
         "tools":[{"kind":"changes","label":"Changes","open":true}],"limits":{"min":320,"keep":440}}
        """
        let view = try JSONDecoder().decode(PanelView.self, from: Data(json.utf8))
        let shown = try #require(view.shown)
        #expect(shown.tool == .visualization)
        #expect(shown.resource == "page-1")
        #expect(shown.title == "Revenue by month")
        #expect(view.tabs.first?.tool == .changes)
    }
}
