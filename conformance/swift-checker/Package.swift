// swift-tools-version:5.9
// A checker of the TDSP 2.0 draft's published vectors, written from the specification's text
// alone (README.md). Foundation only, no dependencies, so that it builds wherever Swift does.
import PackageDescription

let package = Package(
    name: "TDSPSwiftChecker",
    products: [
        .library(name: "TDSPChecker", targets: ["TDSPChecker"]),
        .executable(name: "tdsp-checker", targets: ["tdsp-checker"]),
    ],
    targets: [
        .target(name: "TDSPChecker"),
        .executableTarget(name: "tdsp-checker", dependencies: ["TDSPChecker"]),
        .testTarget(name: "TDSPCheckerTests", dependencies: ["TDSPChecker"]),
    ]
)
