// RFC 8785 (JSON Canonicalization Scheme), as far as LOS-24 and CTL-34 need it: objects with
// their members sorted by the UTF-16 code units of their names (RFC 8785 §3.2.3), strings with
// only the escapes of §3.2.2.2 — quote, backslash, \b \f \n \r \t, other control characters as
// lower-case \u00xx — and everything else as UTF-8, integers as plain digits. A control state
// holds no other number: a clock and the pace are integers (CTL-45, CTL-20).

enum Canonical {
    struct Unsupported: Error, CustomStringConvertible {
        let description: String
    }

    static func serialize(_ value: JSONValue) throws -> String {
        var out = ""
        try write(value, into: &out)
        return out
    }

    static func write(_ value: JSONValue, into out: inout String) throws {
        switch value {
        case .null: out += "null"
        case .bool(let b): out += b ? "true" : "false"
        case .number(let lexeme):
            // An integer of at most 2^53 in magnitude is written by ECMAScript's
            // Number.prototype.toString as its plain digits (RFC 8785 §3.2.2.3).
            guard let i = JSONValue.number(lexeme).plainInteger, i.magnitude <= (1 << 53) else {
                throw Unsupported(description: "number \(lexeme): only integers occur in a control state")
            }
            out += String(i)
        case .string(let s): writeString(s, into: &out)
        case .array(let items):
            out += "["
            for (i, item) in items.enumerated() {
                if i > 0 { out += "," }
                try write(item, into: &out)
            }
            out += "]"
        case .object(let members):
            let sorted = members.sorted { utf16Less($0.0, $1.0) }
            out += "{"
            for (i, (k, v)) in sorted.enumerated() {
                if i > 0 { out += "," }
                writeString(k, into: &out)
                out += ":"
                try write(v, into: &out)
            }
            out += "}"
        }
    }

    static func writeString(_ s: String, into out: inout String) {
        out += "\""
        for scalar in s.unicodeScalars {
            switch scalar.value {
            case 0x22: out += "\\\""
            case 0x5C: out += "\\\\"
            case 0x08: out += "\\b"
            case 0x0C: out += "\\f"
            case 0x0A: out += "\\n"
            case 0x0D: out += "\\r"
            case 0x09: out += "\\t"
            case 0x00..<0x20:
                let hex = String(scalar.value, radix: 16)
                out += "\\u" + String(repeating: "0", count: 4 - hex.count) + hex
            default: out.unicodeScalars.append(scalar)
            }
        }
        out += "\""
    }

    /// RFC 8785 §3.2.3: names compared as arrays of UTF-16 code units.
    static func utf16Less(_ a: String, _ b: String) -> Bool {
        a.utf16.lexicographicallyPrecedes(b.utf16)
    }
}

/// LOS-24: the first 8 bytes of SHA-256 of the input, as 16 lowercase hex digits.
enum Digest {
    static func of(_ bytes: [UInt8]) -> String {
        hex(Array(SHA256.hash(bytes).prefix(8)))
    }

    /// The control digest: `{"closed": …, "targets": {…}}`, each register exactly its `value`,
    /// `clock` and `device`, by RFC 8785, as UTF-8.
    static func control(closed: Bool, targets: [(String, Register)]) throws -> (canonical: String, digest: String) {
        let object = JSONValue.object([
            ("closed", .bool(closed)),
            ("targets", .object(targets.map { ($0.0, $0.1.json) })),
        ])
        let canonical = try Canonical.serialize(object)
        return (canonical, of(Array(canonical.utf8)))
    }
}

func hex(_ bytes: [UInt8]) -> String {
    let digits = Array("0123456789abcdef")
    var s = ""
    for b in bytes {
        s.append(digits[Int(b >> 4)])
        s.append(digits[Int(b & 0x0F)])
    }
    return s
}

func unhex(_ s: String) -> [UInt8]? {
    let chars = Array(s.utf8)
    guard chars.count % 2 == 0 else { return nil }
    func nibble(_ c: UInt8) -> UInt8? {
        switch c {
        case 0x30...0x39: return c - 0x30
        case 0x61...0x66: return c - 0x61 + 10
        case 0x41...0x46: return c - 0x41 + 10
        default: return nil
        }
    }
    var out: [UInt8] = []
    var i = 0
    while i < chars.count {
        guard let h = nibble(chars[i]), let l = nibble(chars[i + 1]) else { return nil }
        out.append(h << 4 | l)
        i += 2
    }
    return out
}
