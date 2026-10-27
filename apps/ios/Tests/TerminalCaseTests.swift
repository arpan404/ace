import Foundation
import Testing
@testable import Ace

/// The shared, language-neutral emulator cases (`fixtures/terminal-emulator`, bundled with the
/// tests): each one's input fed to a fresh screen, then its expected grid checked.
struct TerminalCase: Decodable, Sendable, CustomTestStringConvertible {
    struct Step: Decodable, Sendable {
        let feed: String?
        let resize: [Int]?
    }
    struct Cell: Decodable, Sendable {
        let row: Int
        let column: Int
        let char: String?
        let fg: String?
        let bg: String?
        let flags: [String]?
    }
    struct Expect: Decodable, Sendable {
        let lines: [String]?
        let cursor: [Int]?
        let history: Int?
        let text: String?
        let alternate: Bool?
        let replies: String?
        let title: String?
        let titleLength: Int?
        let modes: [String: Bool]?
        let wrapped: [Int]?
        let cells: [Cell]?
        let linePrefix: [String: String]?
        let lineSuffix: [String: String]?
        let lineMaxScalars: [String: Int]?
    }
    let name: String
    let columns: Int
    let rows: Int
    let scrollback: Int
    let steps: [Step]
    let expect: Expect
    var testDescription: String { name }

    static let all: [TerminalCase] = {
        struct File: Decodable { let cases: [TerminalCase] }
        let bundle = Bundle(for: TerminalCaseBundle.self)
        let urls = bundle.urls(forResourcesWithExtension: "json", subdirectory: "terminal-emulator") ?? []
        return urls.sorted { $0.lastPathComponent < $1.lastPathComponent }.flatMap { url in
            (try? JSONDecoder().decode(File.self, from: Data(contentsOf: url)).cases) ?? []
        }
    }()
}
private final class TerminalCaseBundle {}

@Suite struct TerminalCaseTests {
    @Test func theSharedCasesAreBundled() {
        #expect(TerminalCase.all.count >= 40)
    }

    @Test(arguments: TerminalCase.all)
    func emulatorCase(_ test: TerminalCase) {
        var parser = TerminalParser()
        var screen = TerminalScreen(columns: test.columns, rows: test.rows, scrollback: test.scrollback)
        for step in test.steps {
            if let text = step.feed { parser.feed(text, into: &screen) }
            if let size = step.resize, size.count == 2 { screen.resize(columns: size[0], rows: size[1]) }
        }
        let expect = test.expect
        let lines = screen.lines.map(\.text)
        if let wanted = expect.lines { #expect(lines == wanted) }
        if let cursor = expect.cursor { #expect([screen.cursorRow, screen.cursorColumn] == cursor) }
        if let history = expect.history { #expect(screen.historyCount == history) }
        if let text = expect.text { #expect(screen.text == text) }
        if let alternate = expect.alternate { #expect(screen.usingAlternate == alternate) }
        if let replies = expect.replies { #expect(screen.replies == replies) }
        if let title = expect.title { #expect(screen.title == title) }
        if let length = expect.titleLength { #expect(screen.title.unicodeScalars.count == length) }
        for (mode, value) in expect.modes ?? [:] {
            switch mode {
            case "applicationCursor": #expect(screen.modes.applicationCursor == value)
            case "bracketedPaste": #expect(screen.modes.bracketedPaste == value)
            case "cursorVisible": #expect(screen.modes.cursorVisible == value)
            default: Issue.record("Unknown mode \(mode)")
            }
        }
        if let wrapped = expect.wrapped {
            #expect(screen.lines.indices.filter { screen.lines[$0].wrapped } == wrapped)
        }
        for cell in expect.cells ?? [] { check(cell, in: screen) }
        for (row, prefix) in expect.linePrefix ?? [:] { #expect(lines[Int(row) ?? 0].hasPrefix(prefix)) }
        for (row, suffix) in expect.lineSuffix ?? [:] { #expect(lines[Int(row) ?? 0].hasSuffix(suffix)) }
        for (row, most) in expect.lineMaxScalars ?? [:] { #expect(lines[Int(row) ?? 0].unicodeScalars.count <= most) }
    }

    private func check(_ cell: TerminalCase.Cell, in screen: TerminalScreen) {
        let actual = screen.cell(row: cell.row, column: cell.column)
        if let char = cell.char { #expect(Unicode.Scalar(actual.scalar).map { String($0) } == char) }
        if let fg = cell.fg { #expect(Self.name(actual.style.foreground) == fg, "foreground at \(cell.row),\(cell.column)") }
        if let bg = cell.bg { #expect(Self.name(actual.style.background) == bg, "background at \(cell.row),\(cell.column)") }
        if let flags = cell.flags { #expect(Set(Self.names(actual.style.flags)) == Set(flags), "flags at \(cell.row),\(cell.column)") }
    }
    private static func name(_ colour: TerminalColour) -> String {
        if let index = colour.index { return "idx:\(index)" }
        if let (red, green, blue) = colour.components { return "rgb:\(red),\(green),\(blue)" }
        return "default"
    }
    private static func names(_ flags: TerminalFlags) -> [String] {
        let all: [(String, TerminalFlags)] = [
            ("bold", .bold), ("faint", .faint), ("italic", .italic), ("underline", .underline), ("blink", .blink),
            ("inverse", .inverse), ("invisible", .invisible), ("strike", .strike), ("overline", .overline),
            ("wide", .wide), ("wideTrail", .wideTrail),
        ]
        return all.filter { flags.contains($0.1) }.map(\.0)
    }
}
