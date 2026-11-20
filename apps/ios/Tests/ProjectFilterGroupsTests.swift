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
    }
}

/// The grouped choice holds when the machine filter changes, and New thread opens on the
/// machine's own checkout of it.
final class ProjectFilterAcrossMachinesTests: XCTestCase {
    private let all = ProjectFilterGroups.rows([
        .init(machineId: "mac", workspaceId: "w-1", name: "weather", logical: ["G"], threads: 2),
        .init(machineId: "studio", workspaceId: "w-9", name: "weather", logical: ["G"], threads: 1),
        .init(machineId: "mac", workspaceId: "notes", name: "notes", logical: [], threads: 1),
    ])

    func testAChoiceMadeOnOneMachineStillNamesItsProjectWhenAnotherMachineIsShown() {
        let studio = all.filter { $0.machines.contains("studio") }.map {
            ProjectFilterRow(id: "studio/w-9", name: $0.name, checkouts: ["studio/w-9"], machines: ["studio"], threads: 1)
        }
        // Chosen while every machine showed: the lead is the Mac's checkout.
        let group = ProjectFilterGroups.group(for: "mac/w-1", in: all)
        XCTAssertEqual(group?.checkouts, ["mac/w-1", "studio/w-9"])
        XCTAssertEqual(ProjectFilterGroups.shown(for: "mac/w-1", in: studio, across: all)?.id, "studio/w-9")
    }

    func testNewThreadOpensOnTheChosenMachinesOwnCheckout() {
        XCTAssertEqual(ProjectFilterGroups.checkout(of: "mac/w-1", on: "studio", in: all), "w-9")
        XCTAssertEqual(ProjectFilterGroups.checkout(of: "mac/w-1", on: "mac", in: all), "w-1")
        // A machine without a checkout of it starts on no project rather than another's id.
        XCTAssertNil(ProjectFilterGroups.checkout(of: "mac/notes", on: "studio", in: all))
        // An older bare id keeps meaning that id.
        XCTAssertEqual(ProjectFilterGroups.checkout(of: "w-1", on: "studio", in: all), "w-9")
        XCTAssertEqual(ProjectFilterGroups.checkout(of: "elsewhere", on: "studio", in: all), "elsewhere")
    }
}
