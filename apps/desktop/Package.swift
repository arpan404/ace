// swift-tools-version: 6.0

import PackageDescription

let package = Package(
    name: "AceDesktop",
    platforms: [.macOS(.v14)],
    products: [
        .executable(name: "AceDesktop", targets: ["AceDesktop"])
    ],
    targets: [
        .executableTarget(
            name: "AceDesktop",
            path: "Sources"
        ),
        .testTarget(
            name: "AceDesktopTests",
            dependencies: ["AceDesktop"],
            path: "Tests"
        ),
    ]
)
