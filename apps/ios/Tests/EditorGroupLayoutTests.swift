import Foundation
import Testing
@testable import Ace

@Suite struct EditorGroupLayoutTests {
    /// One group holding `paths`, the last one showing.
    private func single(_ paths: String...) -> EditorGroupLayout {
        var layout = EditorGroupLayout()
        for path in paths { layout.open(path) }
        return layout
    }

    /// `a.swift` and `b.swift` on the left, `c.swift` split to the right.
    private func split() -> EditorGroupLayout {
        var layout = single("a.swift", "b.swift", "c.swift")
        layout.split("c.swift")
        return layout
    }

    private func tabs(_ layout: EditorGroupLayout) -> [[String]] { layout.groups.map(\.tabs) }

    // MARK: Opening

    @Test func aFileOpensAsATabInTheFocusedGroupAndShows() {
        var layout = split()
        layout.focus(layout.groups[0].id)
        layout.open("d.swift")
        #expect(tabs(layout) == [["a.swift", "b.swift", "d.swift"], ["c.swift"]])
        #expect(layout.groups[0].active == "d.swift")
    }

    @Test func aFileAlreadyOpenShowsInItsGroupInsteadOfOpeningTwice() {
        var layout = split()
        layout.focus(layout.groups[0].id)
        layout.open("c.swift")
        #expect(tabs(layout) == [["a.swift", "b.swift"], ["c.swift"]])
        #expect(layout.focused == layout.groups[1].id)
        #expect(layout.shown == "c.swift")
    }

    @Test func openingToTheSideOpensInTheOtherGroup() {
        var layout = single("a.swift")
        layout.openToSide("b.swift")
        #expect(tabs(layout) == [["a.swift"], ["b.swift"]])
        #expect(layout.shown == "b.swift")
        layout.focus(layout.groups[1].id)
        layout.openToSide("a.swift")
        #expect(tabs(layout) == [["a.swift"], ["b.swift"]])
        #expect(layout.focused == layout.groups[0].id)
    }

    // MARK: Splitting and moving

    @Test func splitRightMovesTheFileIntoANewGroupBesideIt() {
        let layout = split()
        #expect(tabs(layout) == [["a.swift", "b.swift"], ["c.swift"]])
        #expect(layout.focused == layout.groups[1].id)
        #expect(layout.groups[0].active == "b.swift")
    }

    @Test func aGroupsOnlyFileCanNotSplitBecauseNothingWouldStay() {
        var layout = single("a.swift")
        #expect(!layout.canSplit("a.swift"))
        layout.split("a.swift")
        #expect(tabs(layout) == [["a.swift"]])
    }

    @Test func thereAreNeverMoreThanTwoGroups() {
        var layout = split()
        layout.focus(layout.groups[0].id)
        layout.split("a.swift")
        // A third group isn't made: the file goes to the other group.
        #expect(tabs(layout) == [["b.swift"], ["c.swift", "a.swift"]])
    }

    @Test func movingAFileToTheOtherGroupShowsItThere() {
        var layout = split()
        layout.move("a.swift", to: layout.groups[1].id)
        #expect(tabs(layout) == [["b.swift"], ["c.swift", "a.swift"]])
        #expect(layout.groups[1].active == "a.swift")
        #expect(layout.focused == layout.groups[1].id)
    }

    @Test func movingAGroupsLastFileAwayMergesTheGroupsBack() {
        var layout = split()
        let left = layout.groups[0].id
        layout.move("c.swift", to: left)
        #expect(tabs(layout) == [["a.swift", "b.swift", "c.swift"]])
        #expect(layout.focused == left)
        #expect(layout.shown == "c.swift")
    }

    // MARK: Closing

    @Test func closingTheShownTabShowsTheOneAfterItThenTheOneBefore() {
        var layout = single("a.swift", "b.swift", "c.swift")
        layout.open("b.swift")
        layout.close("b.swift")
        #expect(layout.shown == "c.swift")
        layout.close("c.swift")
        #expect(layout.shown == "a.swift")
    }

    @Test func closingTheLastTabOfAGroupMergesBackToOneGroup() {
        var layout = split()
        layout.close("c.swift")
        #expect(tabs(layout) == [["a.swift", "b.swift"]])
        #expect(layout.focused == layout.groups[0].id)
        #expect(layout.shown == "b.swift")
    }

    @Test func closingEveryFileLeavesNothingShown() {
        var layout = single("a.swift")
        layout.close("a.swift")
        #expect(layout.groups.isEmpty)
        #expect(layout.shown == nil)
    }

    @Test func aRenamedFileKeepsItsTabAndPlace() {
        var layout = split()
        layout.rename("a.swift", to: "src/a.swift")
        #expect(tabs(layout) == [["src/a.swift", "b.swift"], ["c.swift"]])
        layout.rename("c.swift", to: "z.swift")
        #expect(layout.shown == "z.swift")
    }

    // MARK: Compact width

    @Test func compactWidthShowsOneGroupWithEveryTabAndTheFocusedFile() {
        var layout = split()
        layout.focus(layout.groups[0].id)
        let compact = layout.collapsed
        #expect(compact.groups.map(\.tabs) == [["a.swift", "b.swift", "c.swift"]])
        #expect(compact.shown == "b.swift")
        // The focused group keeps its id, so its editor stays the same one.
        #expect(compact.focused == layout.groups[0].id)
    }

    @Test func goingBackToRegularWidthKeepsTheSplit() {
        var layout = split()
        // Picking a file while compact opens it where it already is, leaving the split intact.
        layout.open("a.swift")
        #expect(layout.collapsed.shown == "a.swift")
        #expect(tabs(layout) == [["a.swift", "b.swift"], ["c.swift"]])
    }

    // MARK: The open files the computer remembers

    @Test func filesClosedElsewhereLeaveTheirTabs() {
        var layout = split()
        layout.sync(open: ["a.swift", "b.swift"], previous: ["a.swift", "b.swift", "c.swift"], keep: nil)
        #expect(tabs(layout) == [["a.swift", "b.swift"]])
    }

    @Test func filesOpenedElsewhereJoinTheFocusedGroup() {
        var layout = split()
        layout.sync(open: ["a.swift", "b.swift", "c.swift", "d.swift"], previous: ["a.swift", "b.swift", "c.swift"], keep: nil)
        #expect(tabs(layout) == [["a.swift", "b.swift"], ["c.swift", "d.swift"]])
        // Joining doesn't take over what shows.
        #expect(layout.shown == "c.swift")
    }

    @Test func aFileJustOpenedHereStaysWhileTheComputerCatchesUp() {
        var layout = single("a.swift", "b.swift")
        // The computer hasn't heard of b.swift yet, and nothing it remembered was closed.
        layout.sync(open: ["a.swift"], previous: ["a.swift"], keep: nil)
        #expect(tabs(layout) == [["a.swift", "b.swift"]])
    }

    @Test func onReturnTabsNoLongerOpenAreDroppedExceptTheFileBeingOpened() {
        var layout = split()
        layout.sync(open: ["b.swift"], previous: nil, keep: "c.swift")
        #expect(tabs(layout) == [["b.swift"], ["c.swift"]])
    }

    // MARK: Restoring

    @Test func threadsSharingACheckoutShareItsGroupsButOtherMachinesDoNot() {
        let here = EditorGroupLayout.storageKey(machine: "mbp", root: "/work/relay", scope: "thread:one")
        #expect(here == EditorGroupLayout.storageKey(machine: "mbp", root: "/work/relay", scope: "thread:two"))
        #expect(here != EditorGroupLayout.storageKey(machine: "mini", root: "/work/relay", scope: "thread:one"))
        #expect(here != EditorGroupLayout.storageKey(machine: "mbp", root: "/work/other", scope: "thread:one"))
        // Until the folder is known, each thread keeps its own.
        #expect(EditorGroupLayout.storageKey(machine: "mbp", root: nil, scope: "thread:one")
            != EditorGroupLayout.storageKey(machine: "mbp", root: nil, scope: "thread:two"))
    }

    @Test func groupsAndTheirFilesComeBackFromStorage() throws {
        var layout = split()
        layout.focus(layout.groups[0].id)
        let restored = try EditorGroupLayout.restore(#require(layout.stored))
        #expect(restored == layout)
        #expect(EditorGroupLayout.restore("not json") == EditorGroupLayout())
    }
}
