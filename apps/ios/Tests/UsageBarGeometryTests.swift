import CoreGraphics
import Testing
@testable import Ace

@Suite struct UsageBarGeometryTests {
    @Test func testEmptyGlyphDrawsThreeCenteredTracks() {
        let tracks = UsageBarGeometry.tracks([])
        #expect(tracks.map(\.track) == [3.5, 8.5, 13.5].map {
            CGRect(x: $0, y: 2, width: 3, height: 16)
        })
        #expect(tracks.allSatisfy { $0.fill == nil })
    }

    @Test func testFillsGrowFromTheBottomAndKeepTheirMinimumHeight() {
        let tracks = UsageBarGeometry.tracks([
            .init(key: "a", label: "Claude", left: 40, tone: .ok, span: "session", window: nil),
            .init(key: "b", label: "Codex", left: 8, tone: .low, span: "session", window: nil),
            .init(key: "c", label: "Other", left: 0, tone: .out, span: "session", window: nil)
        ])
        #expect(tracks[0].fill == CGRect(x: 3.5, y: 11.6, width: 3, height: 6.4))
        #expect(tracks[1].fill == CGRect(x: 8.5, y: 15, width: 3, height: 3))
        #expect(tracks[2].fill == CGRect(x: 13.5, y: 16, width: 3, height: 2))
    }
}
