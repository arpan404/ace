import XCTest
import AppKit
@testable import ScreenHelper

final class ComputerCursorTests: XCTestCase {
    func testTheAgentPointerFollowsItsWindowAcrossDisplays() {
        let anchor = CUCursorAnchor(window: 42, localPoint: CGPoint(x: 120, y: 76))
        XCTAssertEqual(anchor.screenPoint(in: CGRect(x: -1500, y: 100, width: 700, height: 532)), CGPoint(x: -1380, y: 176))
        XCTAssertEqual(anchor.screenPoint(in: CGRect(x: 300, y: 200, width: 700, height: 532)), CGPoint(x: 420, y: 276))
    }

    @MainActor func testTheAgentPointerPersistsBetweenActionsAndLeavesHumanFocusAlone() async throws {
        guard ProcessInfo.processInfo.environment["ACE_CURSOR_INTEGRATION"] == "1" else {
            throw XCTSkip("Opt-in live overlay check uses only a disposable fixture window")
        }
        NSApplication.shared.setActivationPolicy(.accessory)
        let frontmost = NSWorkspace.shared.frontmostApplication?.processIdentifier
        let window = NSWindow(contentRect: CGRect(x: 100, y: 100, width: 360, height: 200),
                              styleMask: [.titled], backing: .buffered, defer: false)
        window.title = "ace cursor fixture"
        window.isReleasedWhenClosed = false
        window.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        window.orderFrontRegardless()
        try await Task.sleep(nanoseconds: 200_000_000)
        let overlay = CUOverlay()
        defer { overlay.hide(); window.close() }
        let screenHeight = try XCTUnwrap(NSScreen.screens.first).frame.height
        let frame = CGRect(x: window.frame.minX, y: screenHeight - window.frame.maxY, width: window.frame.width, height: window.frame.height)
        let target = CUWindow(element: AXUIElementCreateApplication(getpid()), number: CGWindowID(window.windowNumber),
                              title: window.title, frame: frame, onScreen: true, minimized: false, main: false)
        overlay.show(at: CGPoint(x: frame.minX + 120, y: frame.minY + 76), window: target)
        let pointer = try XCTUnwrap(NSApplication.shared.windows.first { $0 !== window && $0.ignoresMouseEvents })
        XCTAssertTrue(pointer.isVisible)
        let initial = pointer.frame.origin
        // The former marker faded after 1.6 seconds, even while the agent was still working.
        try await Task.sleep(nanoseconds: 2_200_000_000)
        XCTAssertTrue(pointer.isVisible)
        XCTAssertEqual(pointer.alphaValue, 1)
        XCTAssertEqual(NSWorkspace.shared.frontmostApplication?.processIdentifier, frontmost)
        window.setFrameOrigin(CGPoint(x: window.frame.minX + 80, y: window.frame.minY + 30))
        try await Task.sleep(nanoseconds: 500_000_000)
        XCTAssertEqual(pointer.frame.minX - initial.x, 80, accuracy: 1)
        XCTAssertEqual(pointer.frame.minY - initial.y, 30, accuracy: 1)
        if let path = ProcessInfo.processInfo.environment["ACE_CURSOR_PREVIEW"], let view = pointer.contentView,
           let bitmap = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: Int(view.bounds.width * 3), pixelsHigh: Int(view.bounds.height * 3), bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0) {
            bitmap.size = view.bounds.size
            view.cacheDisplay(in: view.bounds, to: bitmap)
            try bitmap.representation(using: .png, properties: [:])?.write(to: URL(fileURLWithPath: path))
        }
        overlay.hide()
        XCTAssertFalse(pointer.isVisible)
    }
}
