// swift-tools-version: 5.9
import PackageDescription
import Foundation

let helper = ["Responsibility.swift", "Protocol.swift", "Pipeline.swift", "PointerRelease.swift", "StreamPolicy.swift", "VideoEncoder.swift", "Transcoder.swift", "SimPosture.swift", "FrameFileEncoder.swift", "FrameChanges.swift", "MeasurementFrames.swift", "MeasurementStop.swift", "MeasurementFilmstrip.swift", "InteractionMeasurement.swift", "Metrics.swift", "AXAttributes.swift", "Accessibility.swift", "JPEGEncoder.swift", "FrameWriter.swift", "CaptureRecovery.swift", "Capture.swift", "BackgroundSafety.swift", "ClipboardPaste.swift", "TextInput.swift", "InputDelivery.swift", "ObservationWait.swift", "WindowIdentity.swift", "KeyInput.swift", "AXKeyInput.swift", "AppOperations.swift", "CommandScheduler.swift", "WindowFocus.swift", "WindowContent.swift", "TargetedAXInput.swift", "Input.swift", "InputV2.swift", "ComputerProtocol.swift", "ComputerElementFacts.swift", "ComputerElements.swift", "ComputerTree.swift", "ComputerKeys.swift", "ComputerInput.swift", "ComputerApps.swift", "ComputerCapture.swift", "ComputerMarks.swift", "ComputerPaste.swift", "ComputerGuards.swift", "ComputerPower.swift", "ComputerSessionStatus.swift", "ComputerCursorGlyph.swift", "ComputerOverlay.swift", "ComputerShortcuts.swift", "ComputerInnerActivation.swift", "ComputerFocus.swift", "ComputerTextEditing.swift", "ComputerMarkdown.swift", "ComputerRequestLine.swift", "ComputerCheckpoint.swift", "ComputerEscape.swift", "ComputerSettlePolicy.swift", "ComputerSettler.swift", "ComputerWindowNumbers.swift", "ComputerWindows.swift", "ComputerVisible.swift", "ComputerWalker.swift", "ComputerAppKinds.swift", "ComputerClipboard.swift", "ComputerSearch.swift", "ComputerObservation.swift", "ComputerServiceIO.swift", "ComputerWalkReuse.swift", "ComputerSession.swift", "ComputerKeyboardLayout.swift", "ComputerMenus.swift", "ComputerConditions.swift", "ComputerPointerPlans.swift", "ComputerPointer.swift", "ComputerKeyboard.swift", "ComputerElementActions.swift", "ComputerScroll.swift", "ComputerWindowActions.swift", "ComputerActions.swift", "ComputerService.swift", "Main.swift"]
let fixture = ["TestWindow.swift"]
let inspector = ["InspectJPEG.swift"]
let buildDirectory = URL(fileURLWithPath: #filePath).deletingLastPathComponent().appendingPathComponent("build").path
let excluded = (FileManager.default.fileExists(atPath: buildDirectory) ? ["build"] : []) + [ "Tests", "README.md", "Info.plist", "build.sh", "build-test-window.sh", "bench.sh", "bench-writer.sh", "Bench.swift", "WriterBench.swift", "StreamBench.swift", "bench-stream.sh"]
let package = Package(
    name: "AceScreenHelper", platforms: [.macOS(.v13)],
    products: [.executable(name: "ace-screen-helper", targets: ["ScreenHelper"])],
    targets: [
        .executableTarget(name: "ScreenHelper", path: ".", exclude: excluded + fixture + inspector, sources: helper),
        .executableTarget(name: "ScreenTest", path: ".", exclude: excluded + helper + inspector, sources: fixture),
        .executableTarget(name: "InspectJPEG", path: ".", exclude: excluded + helper + fixture, sources: inspector),
        .testTarget(name: "FrameChangesTests", dependencies: ["ScreenHelper"], path: "Tests", exclude: ["Fixture"])
    ]
)
