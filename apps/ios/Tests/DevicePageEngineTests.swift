import Foundation
import Testing
import WebKit
@testable import Ace

@Suite @MainActor struct DevicePageEngineTests {
    @Test func eachMachineKeepsItsOwnCookiesAcrossLaunches() {
        let first = DevicePageEngine.storeIdentifier(hostId: "host-a")
        #expect(first == DevicePageEngine.storeIdentifier(hostId: "host-a"))
        #expect(first != DevicePageEngine.storeIdentifier(hostId: "host-b"))
    }

    @Test func theLoopbackRulesCompile() async {
        let list: WKContentRuleList? = await withCheckedContinuation { continuation in
            DevicePageEngine.loopbackRules { continuation.resume(returning: $0) }
        }
        #expect(list != nil)
    }

    @Test(arguments: machineLoopbackURLs)
    func theRulesNameEveryLoopbackURLAndNoOther(_ entry: MachineLoopbackURL) throws {
        let matches = try DevicePageEngine.loopbackPatterns.contains { pattern in
            try NSRegularExpression(pattern: pattern, options: [.caseInsensitive])
                .firstMatch(in: entry.url, range: NSRange(entry.url.startIndex..., in: entry.url)) != nil
        }
        #expect(matches == entry.loopback)
        // The navigation check and the rule list agree on every host.
        #expect(DevicePageEngine.isLoopbackHost(URL(string: entry.url)?.host(percentEncoded: false)) == entry.loopback)
    }
}

/// `@ace/ui-core`'s URL table for `isMachineLoopbackHost`, which the rule patterns must match.
struct MachineLoopbackURL: Decodable, Sendable, CustomTestStringConvertible {
    let url: String
    let loopback: Bool
    var testDescription: String { url }
}

/// A missing or unreadable table stops the run rather than test nothing.
let machineLoopbackURLs: [MachineLoopbackURL] = {
    guard let url = Bundle(for: URLTableMarker.self).url(forResource: "machine-loopback-urls", withExtension: "json"),
          let data = try? Data(contentsOf: url),
          let cases = try? JSONDecoder().decode([MachineLoopbackURL].self, from: data), !cases.isEmpty else {
        fatalError("machine-loopback-urls.json is missing from the test bundle")
    }
    return cases
}()

private final class URLTableMarker {}
