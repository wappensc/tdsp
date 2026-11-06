import XCTest
@testable import TDSPChecker

/// Every published vector passes (§3.6).
final class VectorTests: XCTestCase {
    func check(_ path: String, minimum: Int) {
        guard let entry = VectorSuite.files.first(where: { $0.path == path }) else { return XCTFail("no runner for \(path)") }
        let report = VectorSuite.run(path: path, with: entry.run)
        XCTAssertGreaterThanOrEqual(report.outcomes.count, minimum, "\(path): fewer vectors than expected")
        for o in report.outcomes where !o.passed { XCTFail("\(path): \(o.name): \(o.detail)") }
    }

    func testFrames() { check(Edition.vectors("frames"), minimum: 137) }
    func testInvitations() { check(Edition.vectors("invitations"), minimum: 17) }
    func testControl() { check(Edition.vectors("control"), minimum: 47) }
    func testDigests() { check(Edition.vectors("digests"), minimum: 20) }
    func testUpdates() { check(Edition.vectors("updates"), minimum: 52) }
    func testClock() { check(Edition.vectors("clock"), minimum: 35) }
    func testWireFrames() { check(Edition.wire("frames"), minimum: 24) }
    func testWireInvitations() { check(Edition.wire("invitations"), minimum: 3) }
}
