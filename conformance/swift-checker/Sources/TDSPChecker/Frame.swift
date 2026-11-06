// The payload frame (§4): decoding and rejection with the named reason of §4.4, for a receiver
// whose document has the profile yjs-paragraphs/1, written from §1.6, §4, §5.4, §7.5, CTL-20,
// CTL-45 and Appendix A.

/// The reasons of §4.4 that a frame can be judged by on its own; `document-mismatch` and
/// `profile-mismatch` need the delivery and the receiver's state.
public enum FrameReason: String {
    case notJSON = "not-json"
    case unsupportedVersion = "unsupported-version"
    case unknownKind = "unknown-kind"
    case missingField = "missing-field"
    case invalidField = "invalid-field"
    case unsupportedExtension = "unsupported-extension"
}

public struct DecodedFrame {
    public var kind: String
    /// Every top-level member but `tdsp` and `kind`, as written.
    public var fields: [(String, JSONValue)]
    /// The targets of a `resync-response`'s snapshot, where it carries one.
    public var snapshotTargets: [String]?
}

public enum FrameResult {
    case valid(DecodedFrame)
    case rejected(FrameReason, String)
}

/// The profile id grammar of §5, also that of a layer id (§5.6):
/// `name "/" major`, a name of 1 to 100 characters from a lowercase letter or digit followed by
/// lowercase letters, digits, `.` and `-`, and a major from 1 to 999999 without a leading zero.
public enum ProfileId {
    public static func isValid(_ s: String) -> Bool {
        let b = Array(s.utf8)
        guard let slash = b.lastIndex(of: 0x2F) else { return false }
        let name = b[..<slash], major = b[(slash + 1)...]
        func isStart(_ c: UInt8) -> Bool { (0x61...0x7A).contains(c) || (0x30...0x39).contains(c) }
        guard (1...100).contains(name.count), let first = name.first, isStart(first),
              name.allSatisfy({ isStart($0) || $0 == 0x2E || $0 == 0x2D }) else { return false }
        guard (1...6).contains(major.count), let m0 = major.first, (0x31...0x39).contains(m0),
              major.allSatisfy({ (0x30...0x39).contains($0) }) else { return false }
        return true
    }
}

struct Rejection: Error {
    let reason: FrameReason
    let detail: String
}

private func invalid(_ detail: String) -> Rejection { Rejection(reason: .invalidField, detail: detail) }
private func missing(_ detail: String) -> Rejection { Rejection(reason: .missingField, detail: detail) }

/// FRM-9: a field whose name contains `.` is an extension.
private func isExtension(_ name: String) -> Bool { name.contains(".") }

public enum FrameDecoder {
    static let kinds = ["edit", "resync-request", "resync-response", "control", "heartbeat", "decline"]

    public static func decode(_ text: String) -> FrameResult {
        decode(Array(text.utf8))
    }

    public static func decode(_ bytes: [UInt8]) -> FrameResult {
        // not-json: not UTF-8, not JSON, not an object, not I-JSON, or deeper than 32 (§1.6).
        let value: JSONValue
        do { value = try JSONParser.parse(bytes, options: .message) } catch {
            return .rejected(.notJSON, "\(error)")
        }
        guard let members = value.objectMembers else { return .rejected(.notJSON, "not an object") }
        // FRM-13: the version before the kind, the kind before every other field.
        guard Edition.isVersion(value["tdsp"]) else {
            return .rejected(.unsupportedVersion, "tdsp is \(value["tdsp"].map { "\($0)" } ?? "missing")")
        }
        guard let kind = value["kind"]?.stringValue, kinds.contains(kind) else {
            return .rejected(.unknownKind, "kind \(value["kind"].map { "\($0)" } ?? "missing")")
        }
        do {
            let targets = try checkFields(kind: kind, frame: value, members: members)
            try checkCrit(value, members: members)
            return .valid(DecodedFrame(kind: kind, fields: members.filter { $0.0 != "tdsp" && $0.0 != "kind" }, snapshotTargets: targets))
        } catch let r as Rejection {
            return .rejected(r.reason, r.detail)
        } catch {
            return .rejected(.invalidField, "\(error)")
        }
    }

    // MARK: Kinds (§4.3)

    typealias Check = (JSONValue) throws -> Void

    /// Checks every field the kind defines and refuses any other without a `.`; returns the
    /// targets of a `resync-response`'s snapshot.
    static func checkFields(kind: String, frame: JSONValue, members: [(String, JSONValue)]) throws -> [String]? {
        var snapshotTargets: [String]?
        var required: [(String, Check)] = [("documentId", documentId)]
        var optional: [(String, Check)] = []
        switch kind {
        case "edit":
            required += [("update", base64(.update))]
        case "resync-request":
            required += [("requestId", hex16), ("controlClock", nullable(clock)), ("controlDigest", nullable(hex16)),
                         ("all", boolean), ("force", boolean), ("stateVector", base64(.stateVector)),
                         ("stateDigest", hex16), ("stream", hex16), ("sequence", uint32(min: 1))]
        case "resync-response":
            required += [("respondsTo", hex16), ("update", base64(.update)),
                         ("control", nullable { snapshotTargets = try snapshot($0) }),
                         ("attribution", nullable(overlay)), ("stateVector", nullable(base64(.stateVector))),
                         ("stateDigest", nullable(hex16)), ("stream", hex16), ("sequence", uint32(min: 1)),
                         ("piece", uint32(min: 1)), ("pieces", nullable(uint32(min: 1)))]
        case "control":
            required += [("device", deviceTag), ("targets", { _ = try targets($0) }), ("closed", boolean),
                         ("controlClock", nullable(clock)), ("controlDigest", nullable(hex16))]
        case "heartbeat":
            required += [("controlClock", nullable(clock)), ("controlDigest", nullable(hex16)),
                         ("stateVector", base64(.stateVector)), ("stateDigest", hex16), ("stream", hex16),
                         ("sequence", uint32(min: 1))]
            // The sender's last edit again, or absent; never `null` (§4.3).
            optional += [("update", base64(.update))]
        case "decline":
            required += [("reason", { v in
                guard let s = v.stringValue, ["unsupported-profile", "unsupported-version", "declined", "other"].contains(s)
                else { throw invalid("an unknown decline reason") }
            })]
            optional += [("profiles", { v in
                guard let a = v.arrayValue, a.count <= 16 else { throw invalid("profiles is not an array of at most 16") }
                for p in a { guard let s = p.stringValue, ProfileId.isValid(s) else { throw invalid("profiles holds no profile id: \(p)") } }
            }), ("text", { v in
                guard let s = v.stringValue, s.codePointCount <= 500 else { throw invalid("text is not a string of at most 500 characters") }
            })]
        default:
            break
        }
        try checkLayout(frame, members: members, required: required, optional: optional,
                        always: ["tdsp", "kind", "crit"], what: kind)

        // The rules between fields (§4.3, §4.4).
        func isNull(_ name: String) -> Bool { frame[name]?.isNull ?? true }
        switch kind {
        case "resync-request", "heartbeat", "control":
            if isNull("controlClock") != isNull("controlDigest") { throw invalid("controlClock and controlDigest: only one is null") }
        default: break
        }
        if kind == "control", let t = frame["targets"]?.objectMembers, t.isEmpty, frame["closed"]?.boolValue != true {
            throw invalid("a control frame without registers and without the close")
        }
        if kind == "resync-response" {
            if isNull("stateVector") != isNull("stateDigest") { throw invalid("stateDigest is null exactly when stateVector is not") }
            if isNull("pieces") != isNull("stateVector") { throw invalid("pieces is null exactly when stateVector is not") }
            if let pieces = frame["pieces"]?.plainUnsigned, pieces != frame["piece"]?.plainUnsigned {
                throw invalid("pieces differs from piece")
            }
        }
        return snapshotTargets
    }

    /// A closed layout (FRM-5, FRM-9): every required field present and valid, an optional one
    /// valid where present, and no other field whose name has no `.`.
    static func checkLayout(_ object: JSONValue, members: [(String, JSONValue)], required: [(String, Check)],
                            optional: [(String, Check)] = [], always: Set<String> = [], what: String) throws {
        for (name, check) in required {
            guard let v = object[name] else { throw missing("\(what) without \(name)") }
            try check(v)
        }
        for (name, check) in optional { if let v = object[name] { try check(v) } }
        let defined = Set(required.map(\.0) + optional.map(\.0)).union(always)
        for (name, _) in members where !isExtension(name) && !defined.contains(name) {
            throw invalid("\(what) has a field it does not define: \(name)")
        }
    }

    // MARK: crit (FRM-10)

    static func checkCrit(_ frame: JSONValue, members: [(String, JSONValue)]) throws {
        guard let crit = frame["crit"] else { return }
        guard let names = crit.arrayValue, (1...16).contains(names.count) else {
            throw invalid("crit is not a list of 1 to 16 names")
        }
        var seen = Set<String>()
        for n in names {
            guard let s = n.stringValue else { throw invalid("crit holds no name: \(n)") }
            guard isExtension(s) else { throw invalid("crit names a field without a dot: \(s)") }
            guard seen.insert(s).inserted else { throw invalid("crit names \(s) twice") }
            guard members.contains(where: { $0.0 == s }) else { throw invalid("crit names \(s), which the frame does not carry") }
        }
        // This checker implements no extension.
        throw Rejection(reason: .unsupportedExtension, detail: "crit names \(names.compactMap(\.stringValue))")
    }

    // MARK: Field types (§1.6, §4.3)

    static func documentId(_ v: JSONValue) throws {
        guard let s = v.stringValue, (1...255).contains(s.utf8Length) else { throw invalid("documentId is not 1 to 255 bytes") }
    }

    static func boolean(_ v: JSONValue) throws {
        guard v.boolValue != nil else { throw invalid("not a boolean: \(v)") }
    }

    /// "uint32": a JSON integer from 0 to 4 294 967 295 without a fraction or an exponent.
    static func uint32(min: UInt64) -> Check {
        { v in
            guard let n = v.plainUnsigned, n <= UInt64(UInt32.max), n >= min else { throw invalid("not a uint32 of at least \(min): \(v)") }
        }
    }

    /// 16 lowercase hex digits: a request id, a stream tag, a digest.
    static func hex16(_ v: JSONValue) throws {
        guard let s = v.stringValue, s.utf8.count == 16,
              s.utf8.allSatisfy({ (0x30...0x39).contains($0) || (0x61...0x66).contains($0) }) else {
            throw invalid("not 16 lowercase hex digits: \(v)")
        }
    }

    static func deviceTag(_ v: JSONValue) throws {
        guard let s = v.stringValue, Base64.isDeviceTag(s) else { throw invalid("not a device tag: \(v)") }
    }

    static func clock(_ v: JSONValue) throws {
        guard Clock.read(v) != nil else { throw invalid("not a clock: \(v)") }
    }

    static func nullable(_ check: @escaping Check) -> Check {
        { v in if !v.isNull { try check(v) } }
    }

    enum CRDTBytes { case update, stateVector }

    /// Canonical Base64 whose bytes the profile reads as exactly one update or state vector
    /// (§4.4, PRF-1 item 9, Appendix A); an update is never empty.
    static func base64(_ what: CRDTBytes) -> Check {
        { v in
            guard let s = v.stringValue, let bytes = Base64.decodeCanonical(s) else { throw invalid("not canonical Base64: \(v)") }
            switch what {
            case .update:
                guard !bytes.isEmpty else { throw invalid("an empty update") }
                do { _ = try Yjs.readUpdate(bytes) } catch { throw invalid("an update the profile cannot read: \(error)") }
            case .stateVector:
                do { _ = try Yjs.readStateVector(bytes) } catch { throw invalid("a state vector the profile cannot read: \(error)") }
            }
        }
    }

    // MARK: Control state (§4.3, §7.5, CTL-20)

    /// The targets of a `control` frame or a snapshot: at most 5 002 entries, whatever they
    /// name, each a target mapped to a register. 5 002 on members break no layout, only the
    /// bound of CTL-30 (§7.5).
    static func targets(_ v: JSONValue) throws -> [String] {
        guard let entries = v.objectMembers else { throw invalid("targets is not an object") }
        guard entries.count <= 5002 else { throw invalid("more than 5 002 targets") }
        for (name, value) in entries {
            guard let target = Target.parse(name) else { throw invalid("an unknown target: \(name)") }
            _ = try register(value, for: target)
        }
        return entries.map(\.0)
    }

    /// A register: exactly `value`, `clock` and `device`, extension fields aside.
    static func register(_ v: JSONValue, for target: Target) throws -> Register {
        guard let members = v.objectMembers else { throw invalid("a register is not an object") }
        try checkLayout(v, members: members, required: [
            ("value", { if RegisterValue.read($0, for: target) == nil { throw invalid("a value its target cannot take: \($0)") } }),
            ("clock", clock),
            ("device", deviceTag),
        ], what: "a register")
        return Register(value: RegisterValue.read(v["value"]!, for: target)!, clock: Clock.read(v["clock"]!)!, device: v["device"]!.stringValue!)
    }

    /// A control snapshot (§7.5); returns its targets.
    static func snapshot(_ v: JSONValue) throws -> [String] {
        guard let members = v.objectMembers else { throw invalid("control is neither an object nor null") }
        var names: [String] = []
        try checkLayout(v, members: members, required: [
            ("profile", { guard let s = $0.stringValue, ProfileId.isValid(s) else { throw invalid("a snapshot's profile is no profile id") } }),
            ("closed", boolean),
            ("targets", { names = try targets($0) }),
        ], what: "a snapshot")
        return names
    }

    /// An attribution overlay (§5.4).
    static func overlay(_ v: JSONValue) throws {
        guard let members = v.objectMembers else { throw invalid("attribution is neither an object nor null") }
        try checkLayout(v, members: members, required: [
            ("ranges", { ranges in
                guard let list = ranges.arrayValue else { throw invalid("ranges is not an array") }
                var next: UInt64 = 0
                for r in list {
                    guard let rm = r.objectMembers else { throw invalid("a range is not an object") }
                    try checkLayout(r, members: rm, required: [
                        ("start", uint32(min: 0)), ("end", uint32(min: 0)),
                        ("authorId", nullable { a in
                            guard let s = a.stringValue, Target.isMemberId(s) else { throw invalid("an author id that is no MemberId: \(a)") }
                        }),
                    ], what: "a range")
                    let start = r["start"]!.plainUnsigned!, end = r["end"]!.plainUnsigned!
                    guard start == next else { throw invalid("a range that does not start where the previous one ended") }
                    guard end > start else { throw invalid("an empty range") }
                    next = end
                }
            }),
            ("lastEditBySender", { m in
                guard let entries = m.objectMembers else { throw invalid("lastEditBySender is not an object") }
                for (id, offset) in entries {
                    guard Target.isMemberId(id) else { throw invalid("lastEditBySender keyed by no MemberId") }
                    try uint32(min: 0)(offset)
                }
            }),
        ], what: "an overlay")
    }
}
