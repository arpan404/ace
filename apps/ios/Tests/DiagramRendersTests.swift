import Foundation
import Testing
@testable import Ace

/// Diagrams in answers are drawn once per source and appearance, one at a time, and kept, so a
/// transcript scrolled back over them never draws them again (`DiagramRenders`). The drawer is a
/// fake that suspends until the test lets it finish.
@MainActor @Suite struct DiagramRendersTests {
    private final class Picture {
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

    @Test func theSameDiagramAskedTwiceAtOnceIsDrawnOnceForBoth() async {
        let drawer = Drawer()
        let renders = DiagramRenders<Picture> { await drawer.draw($0, $1) }
        async let first = renders.drawn("graph TD; A-->B", dark: false)
        async let second = renders.drawn("graph TD; A-->B", dark: false)
        await settle()
        await drawer.finishAll()
        let (a, b) = await (first, second)
        #expect(drawer.asked == ["graph TD; A-->B|light"])
        #expect(a != nil && a === b)
    }

    @Test func aDiagramDrawnBeforeComesBackWithoutDrawingAgainAndEachAppearanceIsItsOwn() async {
        let drawer = Drawer()
        let renders = DiagramRenders<Picture> { await drawer.draw($0, $1) }
        async let light = renders.drawn("A-->B", dark: false)
        await settle(); await drawer.finishAll()
        let kept = await light
        let again = await renders.drawn("A-->B", dark: false)
        #expect(again === kept)
        #expect(renders.kept("A-->B", dark: false) === kept, "a row coming back draws it in its first layout")
        async let dark = renders.drawn("A-->B", dark: true)
        await settle(); await drawer.finishAll()
        #expect(await dark !== kept)
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
        await drawer.finishAll(); await settle(); await drawer.finishAll(); await settle(); await drawer.finishAll()
        let drawn = await [a, b, c].compactMap { $0?.name }
        #expect(drawn == ["a", "b", "c"])
        #expect(drawer.mostAtOnce == 1)
    }

    @Test func aDiagramScrolledPastBeforeItsTurnIsNeverDrawn() async {
        let drawer = Drawer()
        let renders = DiagramRenders<Picture> { await drawer.draw($0, $1) }
        async let first = renders.drawn("first", dark: false)
        let flung = Task { await renders.drawn("flung past", dark: false) }
        await settle()
        flung.cancel()
        await settle()
        await drawer.finishAll(); await settle(); await drawer.finishAll()
        _ = await first
        #expect(await flung.value == nil)
        #expect(drawer.asked == ["first|light"])
        // Back in view later, it is drawn then.
        async let back = renders.drawn("flung past", dark: false)
        await settle(); await drawer.finishAll()
        #expect(await back?.name == "flung past")
    }

    @Test func aDiagramThatCantBeDrawnIsNotTriedAgainOnEveryScroll() async {
        let drawer = Drawer()
        drawer.broken = ["graph ???"]
        let renders = DiagramRenders<Picture> { await drawer.draw($0, $1) }
        async let first = renders.drawn("graph ???", dark: false)
        await settle(); await drawer.finishAll()
        #expect(await first == nil)
        #expect(await renders.drawn("graph ???", dark: false) == nil)
        #expect(drawer.asked == ["graph ???|light"])
    }

    @Test func onlyTheMostRecentlyDrawnDiagramsAreKept() async {
        let drawer = Drawer()
        let renders = DiagramRenders<Picture>(maxKept: 2) { await drawer.draw($0, $1) }
        for source in ["a", "b", "c"] {
            async let drawn = renders.drawn(source, dark: false)
            await settle(); await drawer.finishAll()
            _ = await drawn
        }
        #expect(renders.kept("a", dark: false) == nil)
        #expect(renders.kept("b", dark: false) != nil)
        #expect(renders.kept("c", dark: false) != nil)
    }

    @Test func onlyMermaidFencesAreDrawn() {
        #expect(DiagramFence.draws("mermaid"))
        #expect(DiagramFence.draws("Mermaid"))
        #expect(!DiagramFence.draws("swift"))
        #expect(!DiagramFence.draws(""))
    }
}
