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

    @Test(arguments: [
        ("http://localhost:3000/", true),
        ("ws://localhost:3000/hmr", true),
        ("http://app.localhost/", true),
        ("http://127.0.0.1:5173/src/main.ts", true),
        ("http://[::1]:8080/", true),
        ("https://example.com/", false),
        ("https://localhost.example.com/", false),
        ("http://192.168.1.4:3000/", false),
    ])
    func theRulesNameEveryLoopbackURLAndNoOther(url: String, loopback: Bool) throws {
        let matches = try DevicePageEngine.loopbackPatterns.contains { pattern in
            try NSRegularExpression(pattern: pattern, options: [.caseInsensitive])
                .firstMatch(in: url, range: NSRange(url.startIndex..., in: url)) != nil
        }
        #expect(matches == loopback)
    }
}
