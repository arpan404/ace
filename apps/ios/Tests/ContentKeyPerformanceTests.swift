import CryptoKit
import Foundation
import Testing
@testable import Ace

@Suite struct ContentKeyPerformanceTests {
    @Test func buildingShelfKeysForAPageAvoidsPerByteStringFormatting() {
        let page = (0..<200).map { "History \($0). " + String(repeating: "Keep process ownership explicit. ", count: 4) }
        func measure(_ key: (String) -> String) -> Duration {
            let clock = ContinuousClock()
            return (0..<5).map { _ in
                clock.measure {
                    let keys = page.map(key)
                    #expect(Set(keys).count == page.count)
                }
            }.sorted()[2]
        }
        func formattedKey(_ text: String) -> String {
            SHA256.hash(data: Data(text.utf8)).map { String(format: "%02x", $0) }.joined()
        }
        #expect(contentKey(page[0]) == formattedKey(page[0]))
        let reference = measure(formattedKey)
        let production = measure(contentKey)
        print("Markdown shelf keys per 200 rows: formatted \(reference), production \(production)")
        #expect(production * 3 < reference)
    }
}
