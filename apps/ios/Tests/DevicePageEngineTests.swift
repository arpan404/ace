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
    @Test func theLoadTheAppAskedForIsThePersonsThroughItsRedirectsUntilItCommits() {
        var person = DevicePageEngine.PersonNavigation()
        let typed = URL(string: "https://accounts.example/login")!
        person.asks(typed)
        let first = person.started(.other, url: typed)
        #expect(first)
        // Each redirect of it comes back as `.other` with another URL.
        let redirected = person.started(.other, url: URL(string: "http://localhost:3000/cb"))
        #expect(redirected)
        person.settled()
        // Once the page is up, a script's navigation is the page's, even to the same URL.
        let later = person.started(.other, url: typed)
        #expect(!later)
    }

    @Test(arguments: [
        (WKNavigationType.linkActivated, false), (.formSubmitted, false), (.other, false),
        (.reload, true), (.backForward, true), (.formResubmitted, true),
    ])
    func whoStartedANavigationTheAppDidNotAskFor(type: WKNavigationType, byPerson: Bool) {
        var person = DevicePageEngine.PersonNavigation()
        let started = person.started(type, url: URL(string: "http://localhost:3000/"))
        #expect(started == byPerson)
    }

    /// A public page's navigations and the person's, to localhost, through the main-frame policy:
    /// WebKit reports each redirect with the method it sends (a 301 or 302 POST as a GET).
    @Test(arguments: [
        ("person, typed address", WKNavigationType.other, true, "GET", true),
        ("person, a POST resubmitted by reload", .formResubmitted, false, "POST", true),
        ("page link", .linkActivated, false, "GET", true),
        ("page form post", .formSubmitted, false, "POST", false),
        ("page form post redirected 301 or 302 (now GET)", .formSubmitted, false, "GET", true),
        ("page form post redirected 303 (now GET)", .formSubmitted, false, "GET", true),
        ("page form post redirected 307 or 308 (still POST)", .formSubmitted, false, "POST", false),
    ] as [(String, WKNavigationType, Bool, String, Bool)])
    func thePolicyJudgesTheMethodOnlyForPageStartedNavigations(name: String, type: WKNavigationType, asked: Bool,
                                                                method: String, allowed: Bool) {
        var person = DevicePageEngine.PersonNavigation()
        let url = URL(string: "http://localhost:3000/cb")!
        if asked { person.asks(url) }
        let byPerson = person.started(type, url: url)
        #expect(DevicePageEngine.allowsMainFrame(to: url, method: method, sourceHost: "attacker.test", byPerson: byPerson) == allowed, "\(name)")
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
