// swift-tools-version: 6.0

import PackageDescription

let package = Package(
    name: "AceDesktop",
    platforms: [.macOS(.v14)],
    products: [
        .executable(name: "AceDesktop", targets: ["AceDesktop"])
    ],
    dependencies: [
        .package(
            url: "https://github.com/krzysztofzablocki/Inject.git",
            revision: "67e3ee9a2b7e40d6af72d07cf1b0d5c04399e809"
        )
    ],
    targets: [
        .executableTarget(
            name: "AceDesktop",
            dependencies: ["Inject"],
            path: "Sources",
            linkerSettings: [
                .unsafeFlags(
                    ["-Xlinker", "-interposable"],
                    .when(configuration: .debug)
                )
            ]
        ),
        .testTarget(
            name: "AceDesktopTests",
            dependencies: ["AceDesktop"],
            path: "Tests"
        ),
    ]
)
