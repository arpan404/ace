// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "AceLockedUse",
    platforms: [.macOS(.v13)],
    products: [
        .library(name: "LockedUseCore", targets: ["LockedUseCore"]),
        .library(name: "LockedUseUI", targets: ["LockedUseUI"]),
        .library(name: "LockedUseIPC", targets: ["LockedUseIPC"]),
        .executable(name: "LockedUsePreview", targets: ["LockedUsePreview"]),
    ],
    targets: [
        .target(name: "LockedUseCore"),
        .target(name: "LockedUseUI", dependencies: ["LockedUseCore"]),
        .target(name: "LockedUseIPC", dependencies: ["LockedUseCore"]),
        .executableTarget(name: "LockedUsePreview", dependencies: ["LockedUseUI"]),
        .testTarget(name: "LockedUseUITests", dependencies: ["LockedUseUI"]),
        .testTarget(name: "LockedUseIPCTests", dependencies: ["LockedUseIPC"]),
        .testTarget(name: "LockedUseCoreTests", dependencies: ["LockedUseCore"]),
    ]
)
