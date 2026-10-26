// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "AceLockedUse",
    platforms: [.macOS(.v13)],
    products: [
        .library(name: "LockedUseCore", targets: ["LockedUseCore"]),
        .library(name: "LockedUseUI", targets: ["LockedUseUI"]),
        .library(name: "LockedUseIPC", targets: ["LockedUseIPC"]),
        .library(name: "LockedUseRuntime", targets: ["LockedUseRuntime"]),
        .library(name: "LockedUseSystem", targets: ["LockedUseSystem"]),
        .library(name: "LockedUseSession", targets: ["LockedUseSession"]),
        .library(name: "LockedUseGuardianKit", targets: ["LockedUseGuardianKit"]),
        .library(name: "LockedUseBrokerKit", targets: ["LockedUseBrokerKit"]),
        .library(name: "LockedUseTransport", targets: ["LockedUseTransport"]),
        .library(name: "LockedUseService", targets: ["LockedUseService"]),
        .executable(name: "LockedUsePreview", targets: ["LockedUsePreview"]),
        .executable(name: "ace-locked-use-guardian", targets: ["LockedUseGuardianDaemon"]),
        .executable(name: "ace-locked-use-authority", targets: ["LockedUseAuthorityBroker"]),
    ],
    targets: [
        .target(name: "LockedUseCore"),
        .target(name: "LockedUseUI", dependencies: ["LockedUseCore"]),
        .target(name: "LockedUseIPC", dependencies: ["LockedUseCore"]),
        .target(name: "LockedUseRuntime", dependencies: ["LockedUseCore", "LockedUseIPC", "LockedUseUI"]),
        // OS adapters: session facts, lock/unlock requests, signing pins, installation probes.
        .target(name: "LockedUseSystem", dependencies: ["LockedUseCore"]),
        .target(name: "LockedUseSession", dependencies: ["LockedUseCore", "LockedUseIPC", "LockedUseRuntime", "LockedUseSystem"]),
        .target(name: "LockedUseGuardianKit", dependencies: ["LockedUseCore", "LockedUseSystem"]),
        .target(name: "LockedUseBrokerKit", dependencies: ["LockedUseCore", "LockedUseIPC", "LockedUseSystem"]),
        .target(name: "LockedUseTransport", dependencies: ["LockedUseCore"]),
        .target(name: "LockedUseService", dependencies: ["LockedUseCore", "LockedUseIPC", "LockedUseRuntime", "LockedUseUI",
            "LockedUseSystem", "LockedUseSession", "LockedUseGuardianKit", "LockedUseBrokerKit", "LockedUseTransport"]),
        .executableTarget(name: "LockedUsePreview", dependencies: ["LockedUseUI"]),
        .executableTarget(name: "LockedUseGuardianDaemon", dependencies: ["LockedUseGuardianKit", "LockedUseSystem"]),
        .executableTarget(name: "LockedUseAuthorityBroker", dependencies: ["LockedUseBrokerKit", "LockedUseIPC", "LockedUseSystem"]),
        .testTarget(name: "LockedUseUITests", dependencies: ["LockedUseUI"]),
        .testTarget(name: "LockedUseIPCTests", dependencies: ["LockedUseIPC"]),
        .testTarget(name: "LockedUseCoreTests", dependencies: ["LockedUseCore"]),
        .testTarget(name: "LockedUseRuntimeTests", dependencies: ["LockedUseRuntime"]),
        .testTarget(name: "LockedUseSessionTests", dependencies: ["LockedUseSession", "LockedUseSystem", "LockedUseRuntime"]),
        .testTarget(name: "LockedUseGuardianTests", dependencies: ["LockedUseGuardianKit", "LockedUseSystem"]),
        .testTarget(name: "LockedUseBrokerTests", dependencies: ["LockedUseBrokerKit", "LockedUseIPC"]),
        .testTarget(name: "LockedUseTransportTests", dependencies: ["LockedUseTransport"]),
        .testTarget(name: "LockedUseServiceTests", dependencies: ["LockedUseService", "LockedUseSession", "LockedUseSystem",
            "LockedUseGuardianKit", "LockedUseTransport", "LockedUseRuntime", "LockedUseIPC"]),
    ]
)
