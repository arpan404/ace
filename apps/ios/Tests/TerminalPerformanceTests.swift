import XCTest
@testable import Ace

/// Terminal throughput budgets (README "Performance budgets"): parsing fast output off the main
/// thread, and building the rows a frame draws. Simulator numbers, in the build the tests run in;
/// they catch the emulator getting slower, not GPU frame rate.
final class TerminalPerformanceTests: XCTestCase {
    /// A build log: coloured words, numbers and plain text, 160 bytes a line.
    private static let log: String = (0..<4_000).map { index in
        "\u{1b}[2m12:00:\(index % 60)\u{1b}[0m \u{1b}[32mINFO\u{1b}[0m compiled \u{1b}[1mpackages/ui-core/src/file-\(index).ts\u{1b}[0m in \(index % 97)ms · cache \u{1b}[36mhit\u{1b}[0m\r\n"
    }.joined()
    /// A full-screen program's redraw: a 120×50 screen addressed row by row with colours.
    private static let frame: String = {
        var out = "\u{1b}[H"
        for row in 1...50 {
            out += "\u{1b}[\(row);1H\u{1b}[3\(row % 8)m"
            out += String(repeating: "█", count: row % 20) + "\u{1b}[0m " + String(repeating: "x", count: 99 - row % 20)
        }
        return out
    }()

    func testFastLogOutputParsesWellAboveWhatAPtyDelivers() {
        let session = TerminalSession(columns: 100, rows: 50)
        let bytes = Self.log.utf8.count
        session.feedNow(Self.log) // warm up
        let start = DispatchTime.now().uptimeNanoseconds
        for _ in 0..<5 { session.feedNow(Self.log) }
        let seconds = Double(DispatchTime.now().uptimeNanoseconds - start) / 1e9
        let megabytesPerSecond = Double(bytes * 5) / 1_048_576 / seconds
        print("terminal log throughput: \(String(format: "%.1f", megabytesPerSecond)) MB/s")
        XCTAssertEqual(session.read { $0.historyCount }, 5_000)
        XCTAssertGreaterThan(megabytesPerSecond, TerminalBudget.logMegabytesPerSecond)
    }

    func testFullScreenRedrawsParseFasterThanTheScreenRefreshes() {
        let session = TerminalSession(columns: 120, rows: 50)
        session.feedNow("\u{1b}[?1049h")
        let start = DispatchTime.now().uptimeNanoseconds
        for _ in 0..<60 { session.feedNow(Self.frame) }
        let perFrame = Double(DispatchTime.now().uptimeNanoseconds - start) / 1e6 / 60
        print("terminal full-screen frame parse: \(String(format: "%.2f", perFrame)) ms")
        XCTAssertTrue(session.read { $0.lines[49].text.hasSuffix("x") })
        XCTAssertLessThan(perFrame, TerminalBudget.fullScreenFrameMilliseconds)
    }

    /// A long OSC string costs its length once, not once per character kept.
    func testALongOscStringParsesInLinearTime() {
        let session = TerminalSession(columns: 80, rows: 24)
        let start = DispatchTime.now().uptimeNanoseconds
        session.feedNow("\u{1b}]0;" + String(repeating: "a", count: 200_000) + "\u{7}ok")
        let milliseconds = Double(DispatchTime.now().uptimeNanoseconds - start) / 1e6
        print("terminal 200k OSC: \(String(format: "%.1f", milliseconds)) ms")
        XCTAssertTrue(session.read { $0.lines[0].text } == "ok")
        XCTAssertLessThan(milliseconds, TerminalBudget.longOscMilliseconds)
    }

    /// Hostile output (screen fills and huge scroll and line counts) never holds the screen lock
    /// long: the renderer reads within a frame while it is parsed.
    func testHostileOutputLetsTheRendererReadWithinAFrame() {
        let session = TerminalSession(columns: 200, rows: 100)
        let hostile = String(repeating: "\u{1b}#8\u{1b}[65535S\u{1b}[65535L\u{1b}[65535M\u{1b}[65535T", count: 2_000)
        let parsing = Thread { session.feedNow(hostile) }
        parsing.start()
        Thread.sleep(forTimeInterval: 0.02)
        var longest = 0.0
        for _ in 0..<20 {
            let start = DispatchTime.now().uptimeNanoseconds
            _ = session.read { $0.rows }
            longest = max(longest, Double(DispatchTime.now().uptimeNanoseconds - start) / 1e6)
            Thread.sleep(forTimeInterval: 0.005)
        }
        session.settle()
        print("terminal longest read wait under hostile output: \(String(format: "%.1f", longest)) ms")
        XCTAssertLessThan(longest, TerminalBudget.lockWaitMilliseconds)
    }

    @MainActor func testBuildingAScreenOfColouredRowsFitsInAFrame() {
        let session = TerminalSession(columns: 120, rows: 50)
        session.feedNow("\u{1b}[?1049h" + Self.frame)
        let lines = session.read { screen in (0..<screen.rows).map { screen.lines[$0] } }
        let fonts = TerminalFonts(size: 12)
        let palette = TerminalPalette(foreground: .white, background: .black, dark: true)
        var rows = 0
        let start = DispatchTime.now().uptimeNanoseconds
        for _ in 0..<10 {
            for line in lines { rows += TerminalRowDrawing(line: line, palette: palette, fonts: fonts, reverse: false).runs.count > 0 ? 1 : 0 }
        }
        let perScreen = Double(DispatchTime.now().uptimeNanoseconds - start) / 1e6 / 10
        print("terminal rows built per screen: \(String(format: "%.2f", perScreen)) ms")
        XCTAssertEqual(rows, 500)
        XCTAssertLessThan(perScreen, TerminalBudget.screenBuildMilliseconds)
    }
}

/// Budgets sit well above the simulator medians so a busy Mac passes and a real regression
/// fails. See apps/ios/README.md.
enum TerminalBudget {
    static let logMegabytesPerSecond = 2.0
    static let fullScreenFrameMilliseconds = 8.0
    static let screenBuildMilliseconds = 16.0
    static let longOscMilliseconds = 200.0
    static let lockWaitMilliseconds = 16.0
}
