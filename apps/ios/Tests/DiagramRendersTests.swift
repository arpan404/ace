import Foundation
import Testing
@testable import Ace

/// Diagrams in answers are drawn once per source and appearance, one at a time, and kept, so a
/// transcript scrolled back over them never draws them again (`DiagramRenders`). The drawer is a
/// fake that suspends until the test lets it finish. Requests whose order matters start one at a
/// time (an `async let` or a `Task` started together have no order), and a regression that leaves
/// a request waiting fails at the time limit instead of hanging the suite.
@MainActor @Suite(.timeLimit(.minutes(1))) struct DiagramRendersTests {
    @MainActor private final class Picture {
        let name: String
        init(_ name: String) { self.name = name }
    }

    /// A drawer that records what it was asked and holds each drawing until `finish`.
    @MainActor private final class Drawer {
        var asked: [String] = []
        var drawing = 0
        var mostAtOnce = 0
        var broken: Set<String> = []
        private var waiting: [CheckedContinuation<Void, Never>] = []
        func draw(_ source: String, _ dark: Bool) async -> Picture? {
            asked.append("\(source)|\(dark ? "dark" : "light")")
            drawing += 1
            mostAtOnce = max(mostAtOnce, drawing)
            await withCheckedContinuation { waiting.append($0) }
            drawing -= 1
            return broken.contains(source) ? nil : Picture(source)
        }
        func finishAll() async {
            while drawing > 0 || !waiting.isEmpty {
                let now = waiting
                waiting = []
                now.forEach { $0.resume() }
                await Task.yield()
            }
        }
    }

    private func settle() async { for _ in 0..<20 { await Task.yield() } }

    /// Lets every drawing queued now, and any it lets start, finish.
    private func drain(_ drawer: Drawer) async {
        for _ in 0..<10 {
            await settle()
            await drawer.finishAll()
        }
    }

    @Test func theSameDiagramAskedTwiceAtOnceIsDrawnOnceForBoth() async {
        let drawer = Drawer()
        let renders = DiagramRenders<Picture> { await drawer.draw($0, $1) }
        async let first = renders.drawn("graph TD; A-->B", dark: false)
        async let second = renders.drawn("graph TD; A-->B", dark: false)
        await drain(drawer)
        let (a, b) = await (first, second)
        #expect(drawer.asked == ["graph TD; A-->B|light"])
        #expect(a != nil && a === b)
    }

    @Test func aDiagramDrawnBeforeComesBackWithoutDrawingAgainAndEachAppearanceIsItsOwn() async {
        let drawer = Drawer()
        let renders = DiagramRenders<Picture> { await drawer.draw($0, $1) }
        async let light = renders.drawn("A-->B", dark: false)
        await drain(drawer)
        let kept = await light
        let again = await renders.drawn("A-->B", dark: false)
        #expect(again === kept)
        #expect(renders.kept("A-->B", dark: false) === kept, "a row coming back draws it in its first layout")
        async let dark = renders.drawn("A-->B", dark: true)
        await drain(drawer)
        let darkPicture = await dark
        #expect(darkPicture != nil && darkPicture !== kept)
        #expect(drawer.asked == ["A-->B|light", "A-->B|dark"])
    }

    @Test func diagramsAreDrawnOneAtATime() async {
        let drawer = Drawer()
        let renders = DiagramRenders<Picture> { await drawer.draw($0, $1) }
        async let a = renders.drawn("a", dark: false)
        async let b = renders.drawn("b", dark: false)
        async let c = renders.drawn("c", dark: false)
        await settle()
        #expect(drawer.drawing == 1)
        await drain(drawer)
        let drawn = await [a, b, c].compactMap { $0?.name }
        #expect(drawn == ["a", "b", "c"])
        #expect(drawer.mostAtOnce == 1)
    }

    @Test func aDiagramScrolledPastBeforeItsTurnIsNeverDrawn() async {
        let drawer = Drawer()
        let renders = DiagramRenders<Picture> { await drawer.draw($0, $1) }
        let first = Task { await renders.drawn("first", dark: false) }
        await settle()
        let flung = Task { await renders.drawn("flung past", dark: false) }
        await settle()
        flung.cancel()
        await drain(drawer)
        _ = await first.value
        let flungPicture = await flung.value
        #expect(flungPicture == nil)
        #expect(drawer.asked == ["first|light"])
        // Back in view later, it is drawn then.
        async let back = renders.drawn("flung past", dark: false)
        await drain(drawer)
        let backPicture = await back
        #expect(backPicture?.name == "flung past")
    }

    @Test func aDiagramThatCantBeDrawnIsNotTriedAgainOnEveryScroll() async {
        let drawer = Drawer()
        drawer.broken = ["graph ???"]
        let renders = DiagramRenders<Picture> { await drawer.draw($0, $1) }
        async let first = renders.drawn("graph ???", dark: false)
        await drain(drawer)
        let firstPicture = await first
        #expect(firstPicture == nil)
        let again = await renders.drawn("graph ???", dark: false)
        #expect(again == nil)
        #expect(drawer.asked == ["graph ???|light"])
    }

    @Test func onlyTheMostRecentlyDrawnDiagramsAreKept() async {
        let drawer = Drawer()
        let renders = DiagramRenders<Picture>(maxKept: 2) { await drawer.draw($0, $1) }
        for source in ["a", "b", "c"] {
            async let drawn = renders.drawn(source, dark: false)
            await drain(drawer)
            _ = await drawn
        }
        #expect(renders.kept("a", dark: false) == nil)
        #expect(renders.kept("b", dark: false) != nil)
        #expect(renders.kept("c", dark: false) != nil)
    }

    /// Each answer's markit view asks through its own gate, closed while the view is off screen
    /// (kept on the thread's shelf) and opened when it shows again (`RenderGate`).
    @Test func aRowScrolledAwayWhileItsDiagramWaitsNeitherDrawsNorHoldsUpRowsOnScreen() async {
        let drawer = Drawer()
        let renders = DiagramRenders<Picture> { await drawer.draw($0, $1) }
        let onScreen = RenderGate(), scrolledAway = RenderGate(), next = RenderGate()
        let first = Task { await onScreen.run { await renders.drawn("first", dark: false) } }
        await settle()
        let away = Task { await scrolledAway.run { await renders.drawn("away", dark: false) } }
        await settle()
        // Queued behind the first, its row leaves the transcript.
        scrolledAway.close()
        await drain(drawer)
        _ = await first.value
        #expect(drawer.asked == ["first|light"], "the row that left is not drawn")
        // A row coming on screen now draws at once, not after the one that left.
        let shown = Task { await next.run { await renders.drawn("next", dark: false) } }
        await settle()
        #expect(drawer.asked == ["first|light", "next|light"])
        await drain(drawer)
        _ = await shown.value
        // Back on screen, the row that left asks again and gets its diagram; markit never gave up.
        scrolledAway.open()
        await drain(drawer)
        let back = await away.value
        #expect(back?.name == "away")
        #expect(drawer.asked == ["first|light", "next|light", "away|light"])
    }

    @Test func aRowBackOnScreenBeforeTheDiagramAheadFinishesStillGetsItsDiagram() async {
        let drawer = Drawer()
        let renders = DiagramRenders<Picture> { await drawer.draw($0, $1) }
        let ahead = RenderGate(), row = RenderGate()
        let first = Task { await ahead.run { await renders.drawn("first", dark: false) } }
        await settle()
        let request = Task { await row.run { await renders.drawn("row", dark: false) } }
        await settle()
        // Scrolled away and straight back while "first" is still drawing.
        row.close()
        await settle()
        row.open()
        await settle()
        #expect(drawer.asked == ["first|light"], "the first is still drawing")
        await drain(drawer)
        _ = await first.value
        let drawn = await request.value
        #expect(drawn?.name == "row", "work the gate cut short is asked for again")
        #expect(drawer.asked == ["first|light", "row|light"])
    }

    @Test func aViewDiscardedWhileItsGateIsClosedStopsWaiting() async {
        let drawer = Drawer()
        let gate = RenderGate()
        gate.close()
        let request = Task { await gate.run { await drawer.draw("never", false) } }
        await settle()
        request.cancel()
        let result = await request.value
        #expect(result == nil)
        #expect(drawer.asked.isEmpty)
    }

    @Test func onlyMermaidFencesAreDrawn() {
        #expect(DiagramFence.draws("mermaid"))
        #expect(DiagramFence.draws("Mermaid"))
        #expect(!DiagramFence.draws("swift"))
        #expect(!DiagramFence.draws(""))
    }
}
