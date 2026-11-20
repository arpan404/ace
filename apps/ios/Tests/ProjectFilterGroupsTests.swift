import XCTest
@testable import Ace

/// The Threads filter shows one row per project across machines (ADR 0189): clones whose
/// logical ids meet are one row with their threads added up, and choosing it covers each.
final class ProjectFilterGroupsTests: XCTestCase {
    private func checkout(_ machine: String, _ workspace: String, _ name: String, _ logical: [String], threads: Int) -> ProjectFilterGroups.Checkout {
        .init(machineId: machine, workspaceId: workspace, name: name, logical: logical, threads: threads)
    }

    func testClonesOfOneRepositoryOnTwoMachinesAreOneRowWithTheirThreadsAddedUp() {
        let rows = ProjectFilterGroups.rows([
            checkout("mac", "w-1", "weather", ["P", "github.com/acme/weather"], threads: 3),
            checkout("studio", "w-9", "weather", ["Q", "github.com/acme/weather"], threads: 2),
            checkout("mac", "notes", "notes", [], threads: 1),
        ])
        XCTAssertEqual(rows.map(\.name), ["notes", "weather"])
        let weather = rows[1]
        XCTAssertEqual(weather.threads, 5)
        XCTAssertEqual(weather.machines, ["mac", "studio"])
        XCTAssertEqual(weather.checkouts, ["mac/w-1", "studio/w-9"])
    }

    func testProjectsWithNoIdsInCommonStayApartEvenWithTheSameName() {
        let rows = ProjectFilterGroups.rows([
            checkout("mac", "a", "site", [], threads: 1),
            checkout("studio", "b", "site", [], threads: 1),
        ])
        XCTAssertEqual(rows.count, 2)
    }

    func testAChainOfSharedIdsJoinsEveryCheckout() {
        // A worktree known by identity only, its clone by identity and remote, a clone elsewhere by remote.
        let rows = ProjectFilterGroups.rows([
            checkout("mac", "worktree", "ace", ["P"], threads: 1),
            checkout("mac", "clone", "ace", ["P", "remote"], threads: 1),
            checkout("studio", "there", "ace", ["R", "remote"], threads: 4),
        ])
        XCTAssertEqual(rows.count, 1)
        XCTAssertEqual(rows.first?.threads, 6)
    }

    func testAStoredChoiceFindsItsRowByCheckoutOrByAnOlderBareId() {
        let rows = ProjectFilterGroups.rows([
            checkout("mac", "w-1", "weather", ["G"], threads: 1),
            checkout("studio", "w-9", "weather", ["G"], threads: 1),
        ])
        XCTAssertEqual(ProjectFilterGroups.row(for: "studio/w-9", in: rows)?.checkouts.count, 2)
        XCTAssertEqual(ProjectFilterGroups.row(for: "w-9", in: rows)?.id, rows.first?.id)
        XCTAssertNil(ProjectFilterGroups.row(for: "", in: rows))
        XCTAssertEqual(ProjectFilterGroups.workspace(of: "studio/w-9"), "w-9")
        XCTAssertEqual(ProjectFilterGroups.workspace(of: "w-9"), "w-9")
    }
}
