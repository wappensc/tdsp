// tdsp-checker [--verbose] [the specification's directory]
// Runs the published vectors and prints, per file, how many pass and which fail; with
// --verbose also every passing vector and, for a rejection, the fault it was rejected for.

import Foundation
import TDSPChecker

let arguments = CommandLine.arguments.dropFirst()
let verbose = arguments.contains("--verbose")
let root = arguments.first(where: { $0 != "--verbose" }).map { URL(fileURLWithPath: $0) } ?? VectorSuite.defaultRoot
var failed = 0
for report in VectorSuite.runAll(root: root) {
    print("\(report.file): \(report.passed) passed, \(report.failed) failed")
    for o in report.outcomes where !o.passed || verbose {
        print("  \(o.passed ? "ok  " : "FAIL") \(o.name)\(o.detail.isEmpty ? "" : ": " + o.detail)")
    }
    failed += report.failed
}
exit(failed == 0 ? 0 : 1)
