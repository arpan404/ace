// swift-tools-version: 5.9
import PackageDescription

let helper = ["Responsibility.swift", "Protocol.swift", "FrameChanges.swift", "Metrics.swift", "AXAttributes.swift", "Accessibility.swift", "JPEGEncoder.swift", "FrameWriter.swift", "Capture.swift", "BackgroundSafety.swift", "WindowFocus.swift", "TargetedAXInput.swift", "Input.swift", "InputV2.swift", "Main.swift"]
let fixture = ["TestWindow.swift"]
let inspector = ["InspectJPEG.swift"]
let excluded = ["build", "Tests", "README.md", "Info.plist", "build.sh", "build-test-window.sh", "bench.sh", "bench-writer.sh", "Bench.swift", "WriterBench.swift"]
let package = Package(
    name: "AceScreenHelper", platforms: [.macOS(.v13)],
    products: [.executable(name: "ace-screen-helper", targets: ["ScreenHelper"])],
    targets: [
        .executableTarget(name: "ScreenHelper", path: ".", exclude: excluded + fixture + inspector, sources: helper),
        .executableTarget(name: "ScreenTest", path: ".", exclude: excluded + helper + inspector, sources: fixture),
        .executableTarget(name: "InspectJPEG", path: ".", exclude: excluded + helper + fixture, sources: inspector),
        .testTarget(name: "FrameChangesTests", dependencies: ["ScreenHelper"], path: "Tests")
    ]
)
