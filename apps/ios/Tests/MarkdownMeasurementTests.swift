import CoreGraphics
import Testing
@testable import Ace

@Suite struct MarkdownMeasurementTests {
    @Test func initialSizeReportsDoNotReflowAlreadyMeasuredAnswers() {
        let page = (0..<160).map { index -> CGFloat in index.isMultiple(of: 5) ? 42 : 63 }
        var requests = 0
        for height in page {
            var measurement = MarkdownMeasurement()
            measurement.measured(height: height, at: 310)
            if measurement.needsLayout(height: height, at: 310) { requests += 1 }
        }
        print("A page of \(page.count) answers requested \(requests) duplicate height updates")
        #expect(requests == 0)
    }

    @Test func aRendererGrowingAfterLayoutStillRequestsMeasurement() {
        var measurement = MarkdownMeasurement()
        #expect(measurement.needsLayout(height: 40, at: 320))
        measurement.measured(height: 40, at: 320)
        #expect(measurement.needsLayout(height: 80, at: 320))
        #expect(measurement.needsLayout(height: 40, at: 270))
        measurement.measured(height: 80, at: 320)
        #expect(!measurement.needsLayout(height: 80, at: 320))
    }
}
