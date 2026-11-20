import Foundation
import Testing
import UIKit
@testable import Ace

extension PageRulesScenario: @retroactive CustomTestStringConvertible {
    public var testDescription: String { name }
}

extension PageJourney: @retroactive CustomTestStringConvertible {
    public var testDescription: String { name }
}

/// The device tab's rules on real web views (ADR 0194): the rule list keeps a public page's
/// requests off the machine's localhost, the main-frame policy keeps its form posts off it, and
/// plain navigations there still load. The machine's localhost is a real HTTP server behind the
/// phone's real listeners; the public site is a real server on the phone's network address. Each
/// refusal sits beside the same request from a localhost page, which must arrive.
@Suite(.serialized) @MainActor struct DevicePageRulesTests {
    private static var window: UIView? {
        UIApplication.shared.connectedScenes.compactMap { ($0 as? UIWindowScene)?.windows.first }.first
    }

    @Test(arguments: PageRulesScenario.all)
    func aDeviceTabsRequestReachesTheMachineOnlyWhereTheRulesAllow(_ scenario: PageRulesScenario) async throws {
        let run = try #require(await PageRulesRun.start(in: Self.window), "no network address to stand for a public site")
        defer { run.stop() }
        // The machine's port is listening, so a request that doesn't arrive was refused.
        #expect(run.listening.listening == [run.machinePort])
        let reached = await run.run(scenario)
        #expect(reached == scenario.reaches)
    }

    /// Reloads, history moves, overlapping loads and new windows, as the person and pages make
    /// them: only a localhost page's own form is sent to the machine again.
    @Test(arguments: PageJourney.all)
    func aJourneyThroughSeveralNavigationsReachesTheMachineOnlyWhereTheRulesAllow(_ journey: PageJourney) async throws {
        let run = try #require(await PageRulesRun.start(in: Self.window), "no network address to stand for a public site")
        defer { run.stop() }
        let (reached, publicSite) = await run.run(journey)
        if let publicSees = journey.publicSees {
            let (path, methods) = publicSees(PageJourney.Bases(machine: "", publicSite: "", id: journey.id))
            // First that what is refused was asked for at all: the replay reached the public site.
            let seen = publicSite.filter { $0.path.hasPrefix(path) }.map(\.method)
            #expect(seen == methods, "the public site saw \(publicSite)")
        }
        #expect(reached == journey.reaches, "reached the machine with \(reached)")
    }

    @Test func aPublicPageHasNoServiceWorkerToReachTheMachineFrom() async throws {
        let run = try #require(await PageRulesRun.start(in: Self.window))
        defer { run.stop() }
        let scenario = PageRulesScenario(name: "service worker", origin: .publicSite, html: { machine, _, hit in
            // A worker would run outside the page's top URL; with none, the fetch is the page's own.
            "<script>navigator.serviceWorker ? navigator.serviceWorker.register('/sw.js') : fetch('\(machine)\(hit)').catch(() => {})</script>"
        }, reaches: nil)
        #expect(await run.run(scenario) == nil)
        #expect(run.publicSite.seen.first(path: "/sw.js") == nil)
    }

    @Test(arguments: loopbackNavigationCases)
    func aTopLevelNavigationToLocalhostFollowsTheSameRuleAsEveryOtherApp(_ entry: LoopbackNavigationCase) {
        #expect(DevicePageEngine.loopbackNavigationAllowed(method: entry.method, initiatorIsLoopback: entry.initiatorIsLoopback,
                                                           redirectStatus: entry.redirectStatus) == entry.allowed)
    }

    @Test(arguments: [
        ("https://example.com/", "POST", "attacker.test", true),
        ("https://localhost.example.com/", "POST", "attacker.test", true),
        ("http://127.0.0.1:3000/", "POST", "attacker.test", false),
        ("http://[::1]:3000/", "POST", "attacker.test", false),
        ("http://app.localhost/", "POST", "attacker.test", false),
        ("http://localhost:3000/", "POST", "::1", true),
    ] as [(String, String, String, Bool)])
    func onlyNavigationsToTheMachinesLoopbackAreJudged(url: String, method: String, source: String, allowed: Bool) {
        #expect(DevicePageEngine.allowsMainFrame(to: URL(string: url), method: method, sourceHost: source) == allowed)
    }
}

/// `@ace/ui-core`'s table for `loopbackNavigationAllowed`, which the Swift copy must match.
struct LoopbackNavigationCase: Decodable, Sendable, CustomTestStringConvertible {
    let `case`: String
    let method: String
    let initiatorIsLoopback: Bool
    let redirectStatus: Int?
    let allowed: Bool
    var testDescription: String { self.case }
}

/// A missing or unreadable table stops the run rather than test nothing.
let loopbackNavigationCases: [LoopbackNavigationCase] = {
    guard let url = Bundle(for: BundleMarker.self).url(forResource: "loopback-navigation-cases", withExtension: "json"),
          let data = try? Data(contentsOf: url),
          let cases = try? JSONDecoder().decode([LoopbackNavigationCase].self, from: data), !cases.isEmpty else {
        fatalError("loopback-navigation-cases.json is missing from the test bundle")
    }
    return cases
}()

/// Finds the test bundle, where the shared table is copied.
private final class BundleMarker {}
