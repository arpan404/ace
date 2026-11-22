import Testing
@testable import Ace

@Suite @MainActor struct GoToLineTests {
    /// A 2,000-line file whose lines are each 10 characters long.
    private func parse(_ typed: String, lines: Int = 2000) -> GoToLine.Target? {
        GoToLine.parse(typed, lineCount: lines, lineLength: { _ in 10 })
    }

    @Test func aLineNumberLandsAtTheStartOfThatLine() {
        #expect(parse("120") == GoToLine.Target(line: 120, column: 1))
        #expect(parse("  7 ") == GoToLine.Target(line: 7, column: 1))
        // Pasted with its line break, as the web's field takes it.
        #expect(parse("120\n") == GoToLine.Target(line: 120, column: 1))
        #expect(parse("\t120:4\r\n") == GoToLine.Target(line: 120, column: 4))
    }

    @Test func lineAndColumnLandOnThatColumn() {
        #expect(parse("120:4") == GoToLine.Target(line: 120, column: 4))
        #expect(parse("120, 4") == GoToLine.Target(line: 120, column: 4))
    }

    @Test func aLinePastTheEndGoesToTheLastLine() {
        #expect(parse("99999") == GoToLine.Target(line: 2000, column: 1))
        #expect(parse("0") == GoToLine.Target(line: 1, column: 1))
    }

    @Test func aColumnPastTheLineEndStopsJustAfterItsLastCharacter() {
        #expect(parse("3:500") == GoToLine.Target(line: 3, column: 11))
    }

    @Test func textThatNamesNoLineGoesNowhere() {
        #expect(parse("") == nil)
        #expect(parse("abc") == nil)
        #expect(parse("12:") == nil)
        #expect(parse("-3") == nil)
        #expect(parse("1:2:3") == nil)
    }

    @Test func anEmptyFileStillHasOneLine() {
        #expect(GoToLine.parse("40", lineCount: 0, lineLength: { _ in 0 }) == GoToLine.Target(line: 1, column: 1))
    }

    @Test func theTrailOffersEveryFolderFromTheRootAndEndsOnTheFile() {
        let trail = FileBreadcrumbs.trail("apps/ios/Sources/App.swift")
        #expect(trail.folders.map(\.name) == ["apps", "ios", "Sources"])
        #expect(trail.folders.map(\.path) == ["apps/", "apps/ios/", "apps/ios/Sources/"])
        #expect(trail.name == "App.swift")
    }

    @Test func aFileAtTheRootHasNoFolders() {
        let trail = FileBreadcrumbs.trail("README.md")
        #expect(trail.folders.isEmpty)
        #expect(trail.name == "README.md")
    }
}
