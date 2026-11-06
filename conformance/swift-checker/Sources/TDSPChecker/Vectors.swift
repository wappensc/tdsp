// Runs the published vector files (§3.6) against this package's readers, and reports per file
// which vectors pass.

import Foundation

public struct VectorOutcome {
    public var name: String
    public var passed: Bool
    public var detail: String
}

public struct FileReport {
    public var file: String
    public var outcomes: [VectorOutcome]
    public var passed: Int { outcomes.filter(\.passed).count }
    public var failed: Int { outcomes.count - passed }
}

struct VectorError: Error, CustomStringConvertible {
    let description: String
}

public enum VectorSuite {
    /// The files, relative to the directory of the specification, TDSP's root.
    public static let files: [(path: String, run: (JSONValue) throws -> [VectorOutcome])] = [
        (Edition.vectors("frames"), frames),
        (Edition.vectors("invitations"), invitations),
        (Edition.vectors("control"), control),
        (Edition.vectors("digests"), digests),
        (Edition.vectors("clock"), clock),
        (Edition.vectors("updates"), updates),
        (Edition.wire("frames"), wireFrames),
        (Edition.wire("invitations"), wireInvitations),
    ]

    /// The specification's directory, found from this source file's place in the package.
    public static var defaultRoot: URL {
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()  // Sources/TDSPChecker
            .deletingLastPathComponent()  // Sources
            .deletingLastPathComponent()  // swift-checker
            .deletingLastPathComponent()  // conformance
            .deletingLastPathComponent()  // the specification's directory
    }

    public static func runAll(root: URL = defaultRoot) -> [FileReport] {
        files.map { run(path: $0.path, root: root, with: $0.run) }
    }

    public static func run(path: String, root: URL = defaultRoot, with runner: (JSONValue) throws -> [VectorOutcome]) -> FileReport {
        let url = root.appendingPathComponent(path)
        do {
            guard let data = FileManager.default.contents(atPath: url.path) else {
                throw VectorError(description: "cannot read \(url.path)")
            }
            let file = try JSONParser.parse([UInt8](data), options: .vectorFile)
            guard file["version"]?.stringValue == FrameDecoder.draftMarker else {
                throw VectorError(description: "the file's version is not \(FrameDecoder.draftMarker)")
            }
            return FileReport(file: path, outcomes: try runner(file))
        } catch {
            return FileReport(file: path, outcomes: [VectorOutcome(name: "(the file)", passed: false, detail: "\(error)")])
        }
    }

    static func list(_ file: JSONValue, _ key: String) throws -> [JSONValue] {
        guard let a = file[key]?.arrayValue else { throw VectorError(description: "no \(key) list") }
        return a
    }

    /// Runs one vector: `body` returns why it fails, or nil, and may note for `--verbose` what
    /// a passing one was decided by.
    static func outcome(_ v: JSONValue, _ body: (inout String) throws -> String?) -> VectorOutcome {
        let name = v["name"]?.stringValue ?? "(unnamed)"
        var note = ""
        do {
            if let failure = try body(&note) { return VectorOutcome(name: name, passed: false, detail: failure) }
            return VectorOutcome(name: name, passed: true, detail: note)
        } catch {
            return VectorOutcome(name: name, passed: false, detail: "\(error)")
        }
    }

    // MARK: frames vectors

    static func frames(_ file: JSONValue) throws -> [VectorOutcome] {
        guard file["profile"]?.stringValue == "yjs-paragraphs/1" else {
            throw VectorError(description: "a profile this checker does not read")
        }
        return try list(file, "vectors").map { v in
            outcome(v) { note in
                guard let text = v["frame"]?.stringValue else { throw VectorError(description: "no frame") }
                let result = FrameDecoder.decode(text)
                if v["valid"]?.boolValue == true {
                    guard case .valid(let frame) = result else {
                        if case .rejected(let r, let d) = result { return "rejected as \(r.rawValue): \(d)" }
                        return "rejected"
                    }
                    if frame.kind != v["kind"]?.stringValue { return "decoded as \(frame.kind)" }
                    if let expected = v["targets"]?.arrayValue?.compactMap(\.stringValue) {
                        if Set(frame.snapshotTargets ?? []) != Set(expected) || (frame.snapshotTargets ?? []).count != expected.count {
                            return "snapshot targets \(frame.snapshotTargets ?? []), expected \(expected)"
                        }
                    }
                    return nil
                }
                guard case .rejected(let reason, let detail) = result else { return "accepted" }
                note = "\(reason.rawValue): \(detail)"
                let expected = v["reason"]?.stringValue ?? "?"
                return reason.rawValue == expected ? nil : "rejected as \(reason.rawValue) (\(detail)), expected \(expected)"
            }
        }
    }

    // MARK: invitations vectors

    static func invitations(_ file: JSONValue) throws -> [VectorOutcome] {
        try list(file, "vectors").map { v in
            outcome(v) { note in
                guard let query = v["query"]?.stringValue else { throw VectorError(description: "no query") }
                let result = InvitationReader.read(query)
                if v["valid"]?.boolValue == true {
                    guard case .valid(let invitation) = result else {
                        if case .refused(let p, let d) = result { return "refused as \(p): \(d)" }
                        return "refused"
                    }
                    return invitation == v["invitation"] ? nil : "read as \(invitation)"
                }
                guard case .refused(let problem, let detail) = result else { return "accepted" }
                note = "\(problem): \(detail)"
                let expected = v["problem"]?.stringValue ?? "?"
                return problem == expected ? nil : "refused as \(problem) (\(detail)), expected \(expected)"
            }
        }
    }

    // MARK: control vectors

    struct Piece {
        var closed: Bool
        var registers: [(String, Target, Register)]
    }

    /// A `control` frame's or a snapshot's registers and close, as the vector writes them.
    static func piece(_ v: JSONValue) throws -> Piece {
        guard let closed = v["closed"]?.boolValue, let targets = v["targets"]?.objectMembers else {
            throw VectorError(description: "not {closed, targets}: \(v)")
        }
        _ = try FrameDecoder.targets(v["targets"]!)
        return Piece(closed: closed, registers: try targets.map { name, value in
            let t = Target.parse(name)!
            return (name, t, try FrameDecoder.register(value, for: t))
        })
    }

    static func merged(_ pieces: [Piece]) -> ControlState {
        var s = ControlState()
        for p in pieces { s.merge(closed: p.closed, registers: p.registers) }
        return s
    }

    static func same(_ a: ControlState, _ b: ControlState) -> Bool {
        a.closed == b.closed && a.targets.count == b.targets.count
            && a.targets.allSatisfy { k, v in b.targets[k]?.1 == v.1 }
    }

    static func permutations<T>(_ items: [T]) -> [[T]] {
        if items.count <= 1 { return [items] }
        var out: [[T]] = []
        for i in items.indices {
            var rest = items
            let first = rest.remove(at: i)
            for p in permutations(rest) { out.append([first] + p) }
        }
        return out
    }

    static func control(_ file: JSONValue) throws -> [VectorOutcome] {
        guard let layer = file["layer"]?.stringValue else { throw VectorError(description: "no layer") }
        return try list(file, "vectors").map { v in
            outcome(v) { note in
                let pieces = try (v["frames"]?.arrayValue ?? []).map(piece)
                let expected = try merged([piece(v["state"]!)])
                // CTL-22: the result depends only on the set of registers, not on their order
                // or on duplicates; and the state taken as one snapshot is itself.
                for order in permutations(pieces) {
                    for sequence in [order, order + order, order.flatMap { [$0, $0] }] {
                        let s = merged(sequence)
                        if !same(s, expected) { return "merged in another order: \(s.targets.mapValues(\.1))" }
                    }
                }
                let state = merged(pieces)
                let asSnapshot = merged([Piece(closed: state.closed, registers: state.targets.map { ($0.key, $0.value.0, $0.value.1) })])
                if !same(asSnapshot, expected) { return "as one snapshot: \(asSnapshot.targets.mapValues(\.1))" }
                let digest = try state.digest.digest
                if digest != v["digest"]?.stringValue { return "digest \(digest)" }
                for (member, rights) in v["rights"]?.objectMembers ?? [] {
                    let document = state.documentRight(of: member)
                    let onLayer = state.layerRight(of: member, on: layer)
                    if document != rights["document"]?.stringValue || onLayer != rights[layer]?.stringValue {
                        return "\(member): \(document) on the document, \(onLayer) on the layer"
                    }
                }
                return nil
            }
        }
    }

    // MARK: digests vectors

    static func deletedRanges(_ v: JSONValue?) throws -> [UInt64: [(clock: UInt64, length: UInt64)]] {
        var out: [UInt64: [(clock: UInt64, length: UInt64)]] = [:]
        for (client, ranges) in v?.objectMembers ?? [] {
            guard let id = UInt64(client) else { throw VectorError(description: "client \(client)") }
            out[id] = try (ranges.arrayValue ?? []).map { r in
                guard let pair = r.arrayValue, pair.count == 2, let c = pair[0].plainUnsigned, let l = pair[1].plainUnsigned else {
                    throw VectorError(description: "range \(r)")
                }
                return (c, l)
            }
        }
        return out
    }

    static func sameRanges(_ a: [UInt64: [(clock: UInt64, length: UInt64)]], _ b: [UInt64: [(clock: UInt64, length: UInt64)]]) -> Bool {
        let na = a.mapValues { Yjs.normalize($0) }.filter { !$0.value.isEmpty }
        let nb = b.mapValues { Yjs.normalize($0) }.filter { !$0.value.isEmpty }
        return na.count == nb.count && na.allSatisfy { k, rs in
            guard let other = nb[k], other.count == rs.count else { return false }
            return zip(rs, other).allSatisfy { $0.clock == $1.clock && $0.length == $1.length }
        }
    }

    static func digests(_ file: JSONValue) throws -> [VectorOutcome] {
        let control = try list(file, "control").map { v in
            outcome(v) { note in
                let p = try piece(v["state"]!)
                var s = ControlState()
                s.merge(closed: p.closed, registers: p.registers)
                let (canonical, digest) = try s.digest
                if canonical != v["canonical"]?.stringValue { return "canonical \(canonical)" }
                if UInt64(canonical.utf8.count) != v["utf8Length"]?.plainUnsigned { return "utf8Length \(canonical.utf8.count)" }
                return digest == v["digest"]?.stringValue ? nil : "digest \(digest)"
            }
        }
        let deletions = try list(file, "deletions").map { v in
            outcome(v) { note in
                var within: [UInt64: UInt64]?
                if let w = v["within"]?.objectMembers {
                    within = [:]
                    for (client, clock) in w { within![UInt64(client)!] = clock.plainUnsigned! }
                }
                let encoding = Yjs.deletionEncoding(try deletedRanges(v["deleted"]), within: within)
                if hex(encoding) != v["encoding"]?.stringValue { return "encoding \(hex(encoding))" }
                let digest = Digest.of(encoding)
                return digest == v["digest"]?.stringValue ? nil : "digest \(digest)"
            }
        }
        let fromUpdates = try list(file, "fromUpdates").map { v in
            outcome(v) { note in
                var replica = YReplica()
                for u in v["updates"]?.arrayValue ?? [] {
                    guard let s = u.stringValue, let bytes = Base64.decodeCanonical(s) else { throw VectorError(description: "update \(u)") }
                    try replica.apply(bytes)
                }
                if replica.projection != v["text"]?.stringValue { return "projects \(replica.projection.debugDescription)" }
                if !sameRanges(replica.deleted, try deletedRanges(v["deleted"])) { return "deleted \(replica.deleted)" }
                let encoding = Yjs.deletionEncoding(replica.deleted)
                if hex(encoding) != v["encoding"]?.stringValue { return "encoding \(hex(encoding))" }
                let digest = Digest.of(encoding)
                return digest == v["digest"]?.stringValue ? nil : "digest \(digest)"
            }
        }
        return control.map { prefixed("control", $0) } + deletions.map { prefixed("deletions", $0) }
            + fromUpdates.map { prefixed("fromUpdates", $0) }
    }

    static func prefixed(_ group: String, _ o: VectorOutcome) -> VectorOutcome {
        VectorOutcome(name: "\(group): \(o.name)", passed: o.passed, detail: o.detail)
    }

    // MARK: updates vectors

    static func bytes(hex text: String) throws -> [UInt8] {
        let b = Array(text.utf8)
        guard b.count % 2 == 0 else { throw VectorError(description: "odd hex") }
        func nibble(_ c: UInt8) throws -> UInt8 {
            switch c {
            case 0x30...0x39: return c - 0x30
            case 0x61...0x66: return c - 0x61 + 10
            default: throw VectorError(description: "not hex")
            }
        }
        return try stride(from: 0, to: b.count, by: 2).map { try nibble(b[$0]) << 4 | nibble(b[$0 + 1]) }
    }

    /// Bytes that are, or are not, an update or a state vector of `yjs-paragraphs/1` (Appendix A).
    static func updates(_ file: JSONValue) throws -> [VectorOutcome] {
        guard file["profile"]?.stringValue == "yjs-paragraphs/1" else {
            throw VectorError(description: "a profile this checker does not read")
        }
        func run(_ key: String, _ field: String, _ read: @escaping ([UInt8]) throws -> Void) throws -> [VectorOutcome] {
            try list(file, key).map { v in
                outcome(v) { note in
                    guard let text = v[field]?.stringValue else { throw VectorError(description: "no \(field)") }
                    let input = try bytes(hex: text)
                    var reads = true
                    do { try read(input) } catch { reads = false; note = "\(error)" }
                    let valid = v["valid"]?.boolValue == true
                    return reads == valid ? nil : (reads ? "read" : "not read: \(note)")
                }
            }
        }
        return try run("updates", "update") { _ = try Yjs.readUpdate($0) }
            + run("stateVectors", "stateVector") { _ = try Yjs.readStateVector($0) }
    }

    // MARK: clock vectors

    static func clockValue(_ v: JSONValue?) throws -> Clock {
        guard let v, let items = v.arrayValue, items.count == 2,
              let ms = items[0].plainInteger, let counter = items[1].plainInteger else {
            throw VectorError(description: "clock \(String(describing: v))")
        }
        return Clock(ms, counter)
    }

    static func clocks(_ v: JSONValue?) throws -> [Clock] { try (v?.arrayValue ?? []).map(clockValue) }

    static func now(_ v: JSONValue) throws -> Double {
        guard let n = v["now"]?.doubleValue else { throw VectorError(description: "no now") }
        return n
    }

    static func clock(_ file: JSONValue) throws -> [VectorOutcome] {
        let constants = file["constants"]
        guard constants?["MAX_MS"]?.plainInteger == Clock.maxMs, constants?["MAX_COUNTER"]?.plainInteger == Clock.maxCounter,
              constants?["SPAN"]?.plainInteger == Clock.span else {
            throw VectorError(description: "constants differ from CTL-45's")
        }
        return try list(file, "vectors").map { v in
            outcome(v) { note in
                func expectDecision(_ clock: Clock?, _ expected: JSONValue?) throws -> String? {
                    if expected?.stringValue == "refused" { return clock == nil ? nil : "decided \(clock!)" }
                    guard let clock else { return "refused" }
                    let e = try clockValue(expected)
                    return clock == e ? nil : "decided \(clock), expected \(e)"
                }
                switch v["op"]?.stringValue {
                case "next":
                    let n = try clockValue(v["clock"]).next()
                    if v["next"]?.stringValue == "none" { return n == nil ? nil : "next \(n!)" }
                    return n == (try clockValue(v["next"])) ? nil : "next \(String(describing: n))"
                case "wall":
                    let w = Clock.wall(try now(v))
                    return w == (try clockValue(v["wall"])) ? nil : "wall \(w)"
                case "cap":
                    let c = Clock.cap(try now(v))
                    return c == (try clockValue(v["cap"])) ? nil : "cap \(c)"
                case "raise":
                    var own = OwnClock(try clockValue(v["own"]))
                    own.raise(try clockValue(v["clock"]), now: try now(v))
                    return own.own == (try clockValue(v["ownAfter"])) ? nil : "own after \(own.own)"
                case "decide":
                    var own = OwnClock(try clockValue(v["own"]))
                    let c = own.decide(now: try now(v), held: try clocks(v["held"]))
                    if let f = try expectDecision(c, v["clock"]) { return f }
                    return own.own == (try clockValue(v["ownAfter"])) ? nil : "own after \(own.own)"
                case "sequence":
                    var own = OwnClock(try clockValue(v["own"]))
                    for (i, step) in (v["steps"]?.arrayValue ?? []).enumerated() {
                        let t = try now(step)
                        if let d = step["decide"] {
                            let c = own.decide(now: t, held: try clocks(d["held"]))
                            if let f = try expectDecision(c, step["clock"]) { return "step \(i + 1): \(f)" }
                        } else {
                            own.raise(try clockValue(step["raise"]), now: t)
                        }
                        if own.own != (try clockValue(step["ownAfter"])) { return "step \(i + 1): own after \(own.own)" }
                    }
                    return nil
                default:
                    return "unknown op \(String(describing: v["op"]))"
                }
            }
        }
    }

    // MARK: wire/ (what the reference encoder writes; read back here)

    /// Each frozen frame decodes to its kind, and its fields to the entry's `input`.
    static func wireFrames(_ file: JSONValue) throws -> [VectorOutcome] {
        try list(file, "entries").map { v in
            outcome(v) { note in
                guard let text = v["frame"]?.stringValue else { throw VectorError(description: "no frame") }
                guard case .valid(let frame) = FrameDecoder.decode(text) else {
                    if case .rejected(let r, let d) = FrameDecoder.decode(text) { return "rejected as \(r.rawValue): \(d)" }
                    return "rejected"
                }
                if frame.kind != v["kind"]?.stringValue { return "decoded as \(frame.kind)" }
                let input = v["input"]?.objectMembers ?? []
                var expected = input.filter { $0.0 != "extensions" }
                expected += input.first(where: { $0.0 == "extensions" })?.1["fields"]?.objectMembers ?? []
                let decoded = JSONValue.object(frame.fields)
                return decoded == .object(expected) ? nil : "fields \(frame.fields.map(\.0)) differ from the input"
            }
        }
    }

    static func wireInvitations(_ file: JSONValue) throws -> [VectorOutcome] {
        try list(file, "entries").map { v in
            outcome(v) { note in
                guard let link = v["link"]?.stringValue else { throw VectorError(description: "no link") }
                guard case .valid(let invitation) = InvitationReader.read(link) else { return "refused" }
                return invitation == v["invitation"] ? nil : "read as \(invitation)"
            }
        }
    }
}
