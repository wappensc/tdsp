// Control state (§7): targets, registers, their merge (CTL-22, CTL-23), and the rights that
// follow (§7.1, LAY-5).

/// A target (§7.1): `member:<id>`, `layer:<layer id>:member:<id>`, `pace` or `close-reason`.
public enum Target: Hashable {
    case member(String)
    case layer(String, member: String)
    case pace
    /// Why the creator closed the document (CTL-23).
    case closeReason

    /// Reads a target as §4.3 and §7.1 write it; nil for anything else.
    static func parse(_ text: String) -> Target? {
        if text == "pace" { return .pace }
        if text == "close-reason" { return .closeReason }
        if text.hasPrefix("member:") {
            let id = String(text.dropFirst("member:".count))
            return isMemberId(id) ? .member(id) : nil
        }
        if text.hasPrefix("layer:") {
            // "A layer id holds no colon, so the first `:member:` after `layer:` ends it."
            let rest = Array(text.utf8.dropFirst("layer:".count))
            let marker = Array(":member:".utf8)
            guard let at = rest.indices.first(where: { rest[$0...].starts(with: marker) }) else { return nil }
            let layer = String(decoding: rest[..<at], as: UTF8.self)
            let id = String(decoding: rest[(at + marker.count)...], as: UTF8.self)
            return ProfileId.isValid(layer) && isMemberId(id) ? .layer(layer, member: id) : nil
        }
        return nil
    }

    /// A MemberId: 1 to 255 bytes in UTF-8 (§4.3, §5.4).
    static func isMemberId(_ s: String) -> Bool { (1...255).contains(s.utf8Length) }
}

/// A register's value (CTL-20).
public enum RegisterValue: Equatable {
    /// `"read"`, `"write"` or `null` — revoked on a member, inherit on a layer.
    case permission(String?)
    /// A uint32 of milliseconds.
    case pace(UInt64)
    /// A reason for the close (CTL-23).
    case reason(String)

    static func read(_ value: JSONValue, for target: Target) -> RegisterValue? {
        switch target {
        case .member, .layer:
            if value.isNull { return .permission(nil) }
            guard let s = value.stringValue, s == "read" || s == "write" else { return nil }
            return .permission(s)
        case .pace:
            guard let v = value.plainUnsigned, v <= UInt64(UInt32.max) else { return nil }
            return .pace(v)
        case .closeReason:
            guard let s = value.stringValue, isCloseReason(s) else { return nil }
            return .reason(s)
        }
    }

    /// CTL-23: a receiver takes any reason of 1 to 128 UTF-8 bytes, whatever it names: one this draft
    /// defines, an application's, or one of a later version (VER-5). Only a device of the creator keeps
    /// to the four codes and FRM-15's names, which a receiver does not check.
    static func isCloseReason(_ s: String) -> Bool {
        (1...128).contains(s.utf8Length)
    }

    var json: JSONValue {
        switch self {
        case .permission(let p): return p.map { .string($0) } ?? .null
        case .pace(let v): return .number(String(v))
        case .reason(let s): return .string(s)
        }
    }

    /// The rank by which CTL-23 orders values at a tie: the lower, the narrower.
    func narrowness(on target: Target) -> Int {
        switch (target, self) {
        // For a member: revoked before read before write.
        case (.member, .permission(nil)): return 0
        case (.member, .permission("read")): return 1
        case (.member, .permission(_)): return 2
        // For a right on a layer: read before inherit before write.
        case (.layer, .permission("read")): return 0
        case (.layer, .permission(nil)): return 1
        case (.layer, .permission(_)): return 2
        // For the pace, the longer interval before the shorter.
        case (_, .pace(let v)): return -Int(v)
        default: return 0
        }
    }
}

public struct Register: Equatable {
    public var value: RegisterValue
    public var clock: Clock
    public var device: String

    var json: JSONValue {
        .object([("value", value.json), ("clock", clock.json), ("device", .string(device))])
    }
}

/// Unicode code point order (CTL-22), which for strings is the order of their scalars.
func codePointLess(_ a: String, _ b: String) -> Bool {
    a.unicodeScalars.map(\.value).lexicographicallyPrecedes(b.unicodeScalars.map(\.value))
}

/// CTL-22: whether `a` holds over `b` on `target` — the greater clock; at equal clocks the
/// later device tag in code point order; at equal clock and device the narrower value, and for
/// the reason for the close the greater string in code point order (CTL-23).
func holds(_ a: Register, over b: Register, on target: Target) -> Bool {
    if a.clock != b.clock { return a.clock > b.clock }
    if a.device != b.device { return codePointLess(b.device, a.device) }
    if case .reason(let x) = a.value, case .reason(let y) = b.value { return !codePointLess(x, y) }
    return a.value.narrowness(on: target) <= b.value.narrowness(on: target)
}

/// A participant's control state: one register per target and the close flag.
public struct ControlState {
    public var closed = false
    /// Keyed by the target as written, so that a state can be compared and digested as sent.
    public var targets: [String: (Target, Register)] = [:]

    public init() {}

    /// Merges registers of a `control` frame or a snapshot (CTL-22), and its close (CTL-23:
    /// a flag that only goes one way).
    public mutating func merge(closed: Bool, registers: [(String, Target, Register)]) {
        if closed { self.closed = true }
        for (name, target, register) in registers {
            if let (_, held) = targets[name], holds(held, over: register, on: target) { continue }
            targets[name] = (target, register)
        }
    }

    public var digest: (canonical: String, digest: String) {
        get throws { try Digest.control(closed: closed, targets: targets.map { ($0.key, $0.value.1) }) }
    }

    /// A member's permission on the document (§7.1): `read`, `write`, `revoked` (a register
    /// holds null) or `unknown` (no register names it).
    public func documentRight(of member: String) -> String {
        guard let (_, r) = targets["member:" + member] else { return "unknown" }
        if case .permission(let p) = r.value { return p ?? "revoked" }
        return "unknown"
    }

    /// LAY-5: the right on a layer if the creator set one, otherwise the permission on the
    /// document; none for a member whose permission on the document is revoked.
    public func layerRight(of member: String, on layer: String) -> String {
        let document = documentRight(of: member)
        if document == "revoked" { return "revoked" }
        if let (_, r) = targets["layer:\(layer):member:\(member)"], case .permission(let p?) = r.value { return p }
        return document
    }
}
