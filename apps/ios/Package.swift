// swift-tools-version: 6.0

import Foundation
import PackageDescription

// `TALLYLINE_CORE_ONLY=1 swift test` (Linux) builds just the pure Foundation
// targets and their tests; the SwiftUI/Design targets need the iOS SDK.
let coreOnly = ProcessInfo.processInfo.environment["TALLYLINE_CORE_ONLY"] == "1"

let package = Package(
    name: "tallyline-ios",
    platforms: [
        .iOS(.v17),
        .macOS(.v14),
    ],
    products: coreOnly ? [] : [
        .library(
            name: "tallyline_ios",
            targets: ["tallyline_ios"]
        ),
        // For app extensions (widgets): core logic and the theme, no app code.
        .library(
            name: "TallylineKit",
            targets: ["TallylineCore", "TallylineDesign"]
        ),
    ],
    targets: (coreOnly ? [] : [
        .target(
            name: "tallyline_ios",
            dependencies: ["TallylineCore", "TallylineDesign"]
        ),
        // Silver Lining tokens and shared SwiftUI components. Needs UIKit,
        // so it is iOS-only.
        .target(name: "TallylineDesign", dependencies: ["TallylineCore"]),
    ]) + [
        // Pure Foundation logic (no UIKit/Security requirements): API client,
        // auth/pairing, models. Builds and tests on Linux.
        .target(name: "TallylineCore"),
        .testTarget(
            name: "TallylineCoreTests",
            dependencies: ["TallylineCore"]
        ),
    ]
)
