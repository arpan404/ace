import Testing
import UIKit
@testable import Ace

/// The operating-system commands the web's xterm handles, as the phone's emulator now does:
/// window title, OSC 8 hyperlinks, indexed and default colours, and their resets. Malformed,
/// unknown and oversized sequences must change nothing and never grow the screen without bound.
@Suite struct TerminalOSCTests {
    private func screen(_ pieces: String..., columns: Int = 30, rows: Int = 5, scrollback: Int = 100) -> TerminalScreen {
        var parser = TerminalParser()
        var screen = TerminalScreen(columns: columns, rows: rows, scrollback: scrollback)
        for piece in pieces { parser.feed(piece, into: &screen) }
        return screen
    }
    private func feed(_ pieces: String..., into screen: inout TerminalScreen) {
        var parser = TerminalParser()
        for piece in pieces { parser.feed(piece, into: &screen) }
    }
    private func rgb(_ colour: CGColor?) -> [Int] {
        (colour?.components ?? []).prefix(3).map { Int(($0 * 255).rounded()) }
    }

    // MARK: Title

    @Test func oscZeroAndTwoRenameTheWindowAndOneOnlyNamesTheIcon() {
        #expect(screen("\u{1b}]0;~/ace\u{07}").title == "~/ace")
        #expect(screen("\u{1b}]2;build: web\u{1b}\\").title == "build: web")
        #expect(screen("\u{1b}]2;kept\u{07}\u{1b}]1;icon\u{07}").title == "kept")
    }

    @Test func theNameShownIsTheRenameThenTheProgramsTitleThenTheShell() {
        #expect(TerminalNames.display(renamed: nil, title: "~/ace", shell: "zsh") == "~/ace")
        #expect(TerminalNames.display(renamed: "Build", title: "~/ace", shell: "zsh") == "Build")
        #expect(TerminalNames.display(renamed: nil, title: "  ", shell: "zsh") == "zsh")
        #expect(TerminalNames.display(renamed: nil, title: "", shell: "zsh") == "zsh")
    }

    @Test func anOversizedOscPayloadIsBoundedAndWhatFollowsStillPrints() {
        let s = screen("\u{1b}]0;\(String(repeating: "t", count: 100_000))\u{07}ok")
        #expect(s.title.unicodeScalars.count == 256)
        #expect(s.lines[0].text == "ok")
    }

    // MARK: Hyperlinks

    @Test func aHyperlinkCoversOnlyTheTextBetweenItsMarksAndSurvivesStyleChanges() {
        // The sequence is split mid-terminator, as output chunks can split it.
        let s = screen("\u{1b}]8;;https://example.com/docs?q=1\u{1b}",
                       "\\\u{1b}[1mlink\u{1b}]8;;\u{1b}\\\u{07} done")
        #expect(s.lines[0].text == "link done")
        #expect(s.hyperlink(row: 0, column: 0) == "https://example.com/docs?q=1")
        #expect(s.hyperlink(row: 0, column: 3) == "https://example.com/docs?q=1")
        #expect(s.hyperlink(row: 0, column: 5) == nil)
        #expect(s.lines[0].cells[0].style.flags.contains(.bold))
    }

    @Test func onlyAddressesThePhoneCanOpenAreFollowed() {
        #expect(TerminalOSC.openable("https://example.com/a")?.absoluteString == "https://example.com/a")
        #expect(TerminalOSC.openable("mailto:dev@example.com") != nil)
        #expect(TerminalOSC.openable("file:///etc/passwd") == nil)
        #expect(TerminalOSC.openable("javascript:alert(1)") == nil)
        #expect(TerminalOSC.openable("not a url") == nil)
    }

    @Test func malformedHyperlinksChangeNothingAndOversizedOnesAreDropped() {
        let malformed = screen("\u{1b}]8\u{07}plain")
        #expect(malformed.lines[0].text == "plain")
        #expect(malformed.hyperlink(row: 0, column: 0) == nil)

        // An address past what the screen keeps ends the link, so later text is not mislabelled.
        let oversized = screen("\u{1b}]8;;https://ok.example\u{07}a",
                               "\u{1b}]8;;https://example.com/\(String(repeating: "a", count: 2_000))\u{07}b")
        #expect(oversized.hyperlink(row: 0, column: 0) == "https://ok.example")
        #expect(oversized.hyperlink(row: 0, column: 1) == nil)
        #expect(oversized.links.count == 1)
    }

    @Test func theHyperlinkRegistryStaysBounded() {
        var text = ""
        for index in 0..<200 {
            text += "\u{1b}]8;;https://example.com/\(index)\u{1b}\\\u{07}x\u{1b}]8;;\u{1b}\\\u{07}"
        }
        let s = screen(text)
        #expect(s.links.count == TerminalScreen.maxLinks)
        #expect(s.links.allSatisfy { $0.hasPrefix("https://example.com/") })
    }

    @Test func theSameAddressKeepsOneSlotInTheRegistry() {
        let s = screen("\u{1b}]8;;https://example.com\u{07}a\u{1b}]8;;\u{07}\u{1b}]8;;https://example.com\u{07}b")
        #expect(s.links == ["https://example.com"])
        #expect(s.hyperlink(row: 0, column: 0) == "https://example.com")
        #expect(s.hyperlink(row: 0, column: 1) == "https://example.com")
    }

    // MARK: Indexed colours (OSC 4, 104)

    @Test func oscFourSetsIndexedColoursAndAnswersQueries() {
        var s = screen()
        feed("\u{1b}]4;1;#ff0000;2;rgb:f/80/0\u{07}", into: &s)
        #expect(s.colours.indexed[1] == TerminalColour.rgb(255, 0, 0))
        #expect(s.colours.indexed[2] == TerminalColour.rgb(255, 128, 0))
        feed("\u{1b}]4;1;?\u{07}\u{1b}]4;2;?\u{07}", into: &s)
        #expect(s.replies == "\u{1b}]4;1;rgb:ffff/0000/0000\u{1b}\\\u{1b}]4;2;rgb:ffff/8080/0000\u{1b}\\")
        // An index a program never set answers with the standard xterm palette.
        s.replies = ""
        feed("\u{1b}]4;16;?\u{07}", into: &s)
        #expect(s.replies == "\u{1b}]4;16;rgb:0000/0000/0000\u{1b}\\")
    }

    @Test func aProgramsPaletteAndOwnColoursAreDrawn() {
        let s = screen("\u{1b}]4;1;#ff8000\u{07}\u{1b}]10;#102030\u{07}\u{1b}]11;#405060\u{07}\u{1b}]12;#708090\u{07}")
        let palette = TerminalPalette(foreground: .white, background: .black, dark: true, colours: s.colours)
        #expect(rgb(palette.resolve(.indexed(1), background: false)) == [255, 128, 0])
        #expect(rgb(palette.foreground) == [16, 32, 48])
        #expect(rgb(palette.background) == [64, 80, 96])
        #expect(rgb(palette.cursor) == [112, 128, 144])
        // A colour the program left alone is still the theme's.
        #expect(rgb(palette.resolve(.indexed(2), background: false)) == [87, 189, 155])
    }

    // MARK: The terminal's own colours (OSC 10, 11, 12 and 110–112)

    @Test func oscTenElevenAndTwelveSetAndReportTheirColours() {
        let unset = screen("\u{1b}]11;?\u{07}\u{1b}]12;?\u{07}")
        #expect(unset.replies == "\u{1b}]11;rgb:1414/1414/1414\u{1b}\\\u{1b}]12;rgb:e6e6/e6e6/e6e6\u{1b}\\")

        var stacked = screen()
        // As in xterm, extra colours on OSC 10 move on to the next slot.
        feed("\u{1b}]10;#010203;#040506;#070809\u{07}", into: &stacked)
        #expect(stacked.colours.foreground == TerminalColour.rgb(1, 2, 3))
        #expect(stacked.colours.background == TerminalColour.rgb(4, 5, 6))
        #expect(stacked.colours.cursor == TerminalColour.rgb(7, 8, 9))
        feed("\u{1b}]10;?\u{07}", into: &stacked)
        #expect(stacked.replies == "\u{1b}]10;rgb:0101/0202/0303\u{1b}\\")
    }

    @Test func resetsRestoreTheDefaultsAndAFullResetForgetsProgramColours() {
        var s = screen("\u{1b}]4;1;#ff0000;2;#00ff00\u{07}\u{1b}]10;#010203\u{07}\u{1b}]11;#040506\u{07}",
                       "\u{1b}]8;;https://example.com\u{07}")
        feed("\u{1b}]104;1\u{07}", into: &s)
        #expect(s.colours.indexed[1] == nil)
        #expect(s.colours.indexed[2] == TerminalColour.rgb(0, 255, 0))
        feed("\u{1b}]104\u{07}", into: &s)
        #expect(s.colours.indexed.isEmpty)
        feed("\u{1b}]110\u{07}\u{1b}]111\u{07}", into: &s)
        #expect(s.colours.foreground == nil && s.colours.background == nil)
        #expect(s.colours.colour(.background) == TerminalColours.defaultBackground)
        feed("\u{1b}c", into: &s)
        #expect(s.colours == TerminalColours())
        #expect(s.currentLink == 0)
    }

    /// Scrollback outlives a full reset and its cells name links by index: a link printed after
    /// the reset must not take an index older text still points at.
    @Test func aFullResetKeepsTheLinksOlderTextStillPointsAt() {
        var s = screen("\u{1b}]8;;https://before.example\u{07}old\u{1b}]8;;\u{07}")
        let before = Int(s.lines[0].cells[0].style.link)
        feed("\u{1b}c\u{1b}]8;;https://after.example\u{07}new\u{1b}]8;;\u{07}", into: &s)
        #expect(s.links[before - 1] == "https://before.example")
        #expect(s.links.firstIndex(of: "https://after.example").map { $0 + 1 } != before)
    }

    // MARK: Everything else

    @Test func commandsTheWebTerminalDoesNotTakeAreIgnoredSafely() {
        // OSC 52 would touch the clipboard, OSC 7 a directory and OSC 133 shell marks; xterm.js
        // handles none of them, so neither does the phone.
        let s = screen("\u{1b}]52;c;SGVsbG8=\u{07}\u{1b}]7;file:///tmp\u{07}\u{1b}]133;A\u{07}",
                       "\u{1b}]1337;SetUserVar=ace=dmFsdWU=\u{07}\u{1b}];2;nope\u{07}\u{1b}]x;y\u{07}text")
        #expect(s.lines[0].text == "text")
        #expect(s.replies.isEmpty)
        #expect(s.colours == TerminalColours())
        #expect(s.links.isEmpty)
        #expect(s.title.isEmpty)
    }

    @Test func malformedColourCommandsChangeNothing() {
        let s = screen("\u{1b}]4;999;#ff0000;x;#00ff00;-1;#000000;3;bogus\u{07}",
                       "\u{1b}]10;#zzzzzz\u{07}\u{1b}]4;1;rgb:1/2\u{07}\u{1b}]4;1;#12345\u{07}ok")
        #expect(s.lines[0].text == "ok")
        #expect(s.colours == TerminalColours())
        #expect(s.replies.isEmpty)
    }
}
