import Testing
@testable import Ace

struct SettingsHistoryTests {
    private struct Run: Identifiable, Equatable {
        let id: String
        let startedAt: Double
        let status: String
    }

    @Test func pollingRetainsOlderRunsAfterTheLastHistoryPage() {
        let old = Run(id: "old", startedAt: 1, status: "done")
        let running = Run(id: "latest", startedAt: 2, status: "working")
        let completed = Run(id: "latest", startedAt: 2, status: "done")
        let next = refreshedAutomationHistory([completed], keeping: [running, old], startedAt: { $0.startedAt })
        #expect(next == [completed, old])
    }
}
