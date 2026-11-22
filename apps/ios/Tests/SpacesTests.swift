import Foundation
import Testing
@testable import Ace

/// The iPhone's copy of the space rules (`Spaces`) against `@ace/client`'s own table
/// (`packages/client/src/ace-spaces-cases.json`), which the TypeScript passes too: which machines
/// a space shows, which space shows, why New thread can't start, the admin's row and notice labels.
struct SpacesTests {
    @Test(arguments: spaceCases)
    func theSpaceRulesMatchDesktopAndTheWeb(_ entry: SpaceCase) {
        let hostsOf = entry.hostsOf.mapValues(Set.init)
        let shown = Spaces.shown(chosen: entry.chosen, spaces: entry.spaces)
        let inSpace = entry.machines.indices.filter {
            Spaces.contains(entry.machines[$0], space: shown, hostsOf: hostsOf, orgs: entry.orgs)
        }
        let noticeOrg = Spaces.org(of: entry.noticeHost, spaces: entry.spaces ?? [], hostsOf: hostsOf)
        #expect(shown?.id == entry.expect.shown)
        #expect(inSpace == entry.expect.inSpace)
        #expect(Spaces.startBlock(shown, hostsOf: hostsOf, reachable: inSpace.count) == entry.expect.phoneStartBlock)
        #expect(Spaces.manageLine(shown) == entry.expect.manage)
        #expect(Spaces.noticeLabel(org: noticeOrg, spaces: entry.spaces) == entry.expect.noticeLabel)
    }

    @MainActor @Test func theListsShowTheSpacesMachinesWhileEveryRuntimeStaysReachable() {
        let inbox = MachineInbox(defaults: UserDefaults(suiteName: "spaces-\(UUID().uuidString)")!, now: { 0 })
        let laptop = ClientModel(now: { 0 }), build = ClientModel(now: { 0 })
        inbox.attach("laptop", name: "Laptop", client: laptop)
        inbox.attach("acme-build", name: "acme-build", client: build)
        inbox.inSpace = { $0 == "acme-build" }

        #expect(inbox.sessions.map(\.hostId) == ["acme-build"])
        #expect(inbox.all.map(\.hostId) == ["laptop", "acme-build"])
        // A notice from Personal still reaches its machine's runtime.
        #expect(inbox.client("laptop") === laptop)
    }

    @MainActor @Test func anOrganizationWithNoMachinesHereStartsNoThread() {
        let inbox = MachineInbox(defaults: UserDefaults(suiteName: "spaces-\(UUID().uuidString)")!, now: { 0 })
        #expect(inbox.canStartThreads)
        inbox.spaceBlock = { "Acme Robotics has no machines yet." }
        #expect(!inbox.canStartThreads)
    }
}

/// One row of the shared table.
struct SpaceCase: Decodable, Sendable, CustomTestStringConvertible {
    struct Expect: Decodable, Sendable {
        let shown: String?
        let inSpace: [Int]
        let startBlock: String?
        /// The iPhone's wording: a phone has no windows.
        let phoneStartBlock: String?
        let manage: String?
        let noticeLabel: String?
    }
    let `case`: String
    let chosen: String
    let spaces: [AceOrgSpace]?
    let hostsOf: [String: [String]]
    let orgs: [String]?
    let machines: [String?]
    let noticeHost: String?
    let expect: Expect
    var testDescription: String { self.case }
}

/// A missing or unreadable table stops the run rather than test nothing.
let spaceCases: [SpaceCase] = {
    guard let url = Bundle(for: SpacesBundleMarker.self).url(forResource: "ace-spaces-cases", withExtension: "json"),
          let data = try? Data(contentsOf: url),
          let cases = try? JSONDecoder().decode([SpaceCase].self, from: data), !cases.isEmpty else {
        fatalError("ace-spaces-cases.json is missing from the test bundle")
    }
    return cases
}()

private final class SpacesBundleMarker {}
