import CoreGraphics
import Testing
@testable import Ace

/// Where the full-screen viewer puts an image at rest.
@Suite struct MediaFitTests {
    private let phone = CGSize(width: 402, height: 874)

    @Test func aSmallImageGrowsToTheScreensWidthKeepingItsShape() {
        let fitted = MediaFit.fitted(CGSize(width: 120, height: 80), in: phone)
        #expect(abs(fitted.width - 402) < 0.01)
        #expect(abs(fitted.height - 268) < 0.01)
    }

    @Test func aLargeTallImageShrinksToTheScreensHeight() {
        let fitted = MediaFit.fitted(CGSize(width: 3000, height: 9000), in: phone)
        #expect(abs(fitted.height - 874) < 0.01)
        #expect(fitted.width <= 402)
    }

    @Test func anImageWithoutASizeTakesNoSpace() {
        #expect(MediaFit.fitted(.zero, in: phone) == .zero)
    }

    @Test func aLongScreenshotZoomsFarEnoughForItsWidthToFillTheScreen() {
        let screenshot = CGSize(width: 1179, height: 20000)
        let fitted = MediaFit.fitted(screenshot, in: phone)
        let zoom = MediaFit.maximumZoom(fitted: fitted, in: phone)
        #expect(abs(fitted.width * zoom - phone.width) < 0.01)
    }

    @Test func anOrdinaryPhotoStillZoomsToFourTimes() {
        let fitted = MediaFit.fitted(CGSize(width: 4032, height: 3024), in: phone)
        #expect(MediaFit.maximumZoom(fitted: fitted, in: phone) == 4)
    }

    @Test func aLongScreenshotDecodesAtItsFullWidthUnderTheAreaCap() {
        let side = ImageDecoding.longSide(width: 1179, height: 20000, area: ImageDecoding.viewedArea)
        #expect(side == 20000)
    }

    @Test func aHugePhotoShrinksToTheAreaCapKeepingItsShape() {
        let side = ImageDecoding.longSide(width: 8000, height: 6000, area: 12_000_000)
        #expect(side == 4000)
    }
}

/// Where published media opens from the transcript, as the web opens it.
@Suite struct MediaOpeningTests {
    private func row(_ type: String, _ text: String) -> TranscriptRow {
        TranscriptRow(id: "page", index: 0, type: type, role: "assistant", text: text,
                      complete: true, createdAt: 0, agentId: "root", truncated: false,
                      detail: nil, quiet: nil)
    }

    @Test func aVisualizationOpensFullScreenOnAPhoneAndAsATitledPanelTabBesideTheThread() {
        #expect(MediaOpening.of(row("html", "Revenue by month"), panelBeside: false) == .fullScreen)
        #expect(MediaOpening.of(row("html", "Revenue by month"), panelBeside: true) == .panel(title: "Revenue by month"))
    }

    @Test func anImageOpensInItsViewerWhereverItIs() {
        #expect(MediaOpening.of(row("image", "Screenshot"), panelBeside: false) == .viewer)
        #expect(MediaOpening.of(row("image", "Screenshot"), panelBeside: true) == .viewer)
    }

    @Test func aPanelTabAlwaysHasATitleThePanelAccepts() {
        #expect(MediaOpening.of(row("html", "  "), panelBeside: true) == .panel(title: "Visualization"))
        let long = String(repeating: "a", count: 400)
        #expect(MediaOpening.of(row("html", long), panelBeside: true) == .panel(title: String(repeating: "a", count: 160)))
    }
}
