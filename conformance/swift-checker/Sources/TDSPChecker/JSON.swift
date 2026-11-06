// JSON (RFC 8259) as §1.6 restricts it, read by a parser of this package's own.
//
// A number keeps its spelling, because §1.6 and §4.3 judge an integer field by how it is
// written ("without a fraction or an exponent"), not only by its value. The strict mode is
// I-JSON as §1.6 needs it — no member named twice, no unpaired surrogate — with the nesting
// bound of 32 found in one pass before parsing (JSN-1). The lenient mode is what a Yjs reader
// needs for JSON content inside an update (Appendix A names `JSON.parse`'s reading there).

public indirect enum JSONValue {
    case null
    case bool(Bool)
    /// The number as written.
    case number(String)
    case string(String)
    case array([JSONValue])
    /// Members in the order written.
    case object([(String, JSONValue)])
}

extension JSONValue {
    subscript(key: String) -> JSONValue? {
        guard case .object(let members) = self else { return nil }
        return members.first(where: { $0.0 == key })?.1
    }

    var objectMembers: [(String, JSONValue)]? {
        if case .object(let m) = self { return m }
        return nil
    }

    var arrayValue: [JSONValue]? {
        if case .array(let a) = self { return a }
        return nil
    }

    var stringValue: String? {
        if case .string(let s) = self { return s }
        return nil
    }

    var boolValue: Bool? {
        if case .bool(let b) = self { return b }
        return nil
    }

    var isNull: Bool {
        if case .null = self { return true }
        return false
    }

    /// A number written as plain digits (no sign, fraction or exponent) that fits in UInt64.
    var plainUnsigned: UInt64? {
        guard case .number(let lexeme) = self else { return nil }
        return JSONValue.plainUnsigned(lexeme)
    }

    /// A number written as an optional minus and digits only.
    var plainInteger: Int64? {
        guard case .number(let lexeme) = self else { return nil }
        if lexeme.hasPrefix("-") {
            guard let magnitude = JSONValue.plainUnsigned(String(lexeme.dropFirst())),
                  magnitude <= UInt64(Int64.max) else { return nil }
            return -Int64(magnitude)
        }
        guard let v = JSONValue.plainUnsigned(lexeme), v <= UInt64(Int64.max) else { return nil }
        return Int64(v)
    }

    /// Any JSON number as a Double (for the wall clock `now` of the clock vectors).
    var doubleValue: Double? {
        guard case .number(let lexeme) = self else { return nil }
        return Double(lexeme)
    }

    static func plainUnsigned(_ lexeme: String) -> UInt64? {
        guard !lexeme.isEmpty, lexeme.utf8.allSatisfy({ $0 >= 0x30 && $0 <= 0x39 }) else { return nil }
        return UInt64(lexeme)
    }
}

extension JSONValue: Equatable {
    /// Equality of values: objects regardless of member order, numbers by value where both are
    /// integers, otherwise by spelling.
    public static func == (a: JSONValue, b: JSONValue) -> Bool {
        switch (a, b) {
        case (.null, .null): return true
        case (.bool(let x), .bool(let y)): return x == y
        case (.string(let x), .string(let y)): return x == y
        case (.number(let x), .number(let y)):
            if x == y { return true }
            if let ix = JSONValue.number(x).plainInteger, let iy = JSONValue.number(y).plainInteger { return ix == iy }
            return false
        case (.array(let x), .array(let y)): return x == y
        case (.object(let x), .object(let y)):
            guard x.count == y.count else { return false }
            for (k, v) in x {
                guard let w = y.first(where: { $0.0 == k })?.1, w == v else { return false }
            }
            return true
        default: return false
        }
    }
}

struct JSONError: Error, CustomStringConvertible {
    let description: String
}

struct JSONParser {
    struct Options {
        /// I-JSON (RFC 7493) as §1.6 needs it: no member twice, no unpaired surrogate.
        var iJSON: Bool
        /// The deepest nesting accepted; the outermost array or object is level 1.
        var maxDepth: Int
        /// Whether the text must be an object (a frame) or may be any value.
        var objectOnly: Bool

        /// A message this specification defines (§1.6).
        static let message = Options(iJSON: true, maxDepth: 32, objectOnly: true)
        /// A JSON text inside a Yjs update, as `JSON.parse` reads it, nested at most 32 levels
        /// as a frame is (Appendix A, "Reading without applying").
        static let yjsContent = Options(iJSON: false, maxDepth: 32, objectOnly: false)
        /// The vector files themselves.
        static let vectorFile = Options(iJSON: true, maxDepth: 1000, objectOnly: true)
    }

    let bytes: [UInt8]
    var pos = 0
    let options: Options

    /// Parses `bytes`, which must be UTF-8, as one JSON text.
    static func parse(_ bytes: [UInt8], options: Options) throws -> JSONValue {
        guard UTF8Text.scalars(bytes[...]) != nil else { throw JSONError(description: "not UTF-8") }
        // JSN-1: the depth in one pass, before a parser that recurses once per level.
        if exceedsDepth(bytes, options.maxDepth) { throw JSONError(description: "nests deeper than \(options.maxDepth)") }
        var p = JSONParser(bytes: bytes, options: options)
        p.skipWhitespace()
        let value = try p.parseValue()
        p.skipWhitespace()
        guard p.pos == bytes.count else { throw JSONError(description: "text after the value") }
        if options.objectOnly, case .object = value {} else if options.objectOnly {
            throw JSONError(description: "not an object")
        }
        return value
    }

    static func parse(_ text: String, options: Options) throws -> JSONValue {
        try parse(Array(text.utf8), options: options)
    }

    /// Whether arrays and objects nest deeper than `limit`, judged outside strings.
    static func exceedsDepth(_ bytes: [UInt8], _ limit: Int) -> Bool {
        var depth = 0
        var inString = false
        var escaped = false
        for b in bytes {
            if inString {
                if escaped { escaped = false } else if b == 0x5C { escaped = true } else if b == 0x22 { inString = false }
                continue
            }
            switch b {
            case 0x22: inString = true
            case 0x5B, 0x7B:
                depth += 1
                if depth > limit { return true }
            case 0x5D, 0x7D: depth -= 1
            default: break
            }
        }
        return false
    }

    mutating func skipWhitespace() {
        while pos < bytes.count, [0x20, 0x09, 0x0A, 0x0D].contains(bytes[pos]) { pos += 1 }
    }

    mutating func parseValue() throws -> JSONValue {
        guard pos < bytes.count else { throw JSONError(description: "unexpected end") }
        switch bytes[pos] {
        case 0x7B: return try parseObject()
        case 0x5B: return try parseArray()
        case 0x22: return .string(try parseString())
        case 0x74: try expect("true"); return .bool(true)
        case 0x66: try expect("false"); return .bool(false)
        case 0x6E: try expect("null"); return .null
        default: return .number(try parseNumber())
        }
    }

    mutating func expect(_ word: String) throws {
        let w = Array(word.utf8)
        guard pos + w.count <= bytes.count, Array(bytes[pos..<pos + w.count]) == w else {
            throw JSONError(description: "invalid literal")
        }
        pos += w.count
    }

    mutating func parseObject() throws -> JSONValue {
        pos += 1
        var members: [(String, JSONValue)] = []
        var seen = Set<String>()
        skipWhitespace()
        if pos < bytes.count, bytes[pos] == 0x7D { pos += 1; return .object(members) }
        while true {
            skipWhitespace()
            guard pos < bytes.count, bytes[pos] == 0x22 else { throw JSONError(description: "expected a member name") }
            let key = try parseString()
            skipWhitespace()
            guard pos < bytes.count, bytes[pos] == 0x3A else { throw JSONError(description: "expected ':'") }
            pos += 1
            skipWhitespace()
            let value = try parseValue()
            if seen.contains(key) {
                if options.iJSON { throw JSONError(description: "member named twice: \(key)") }
                // JSON.parse: the last one holds.
                members.removeAll(where: { $0.0 == key })
            }
            seen.insert(key)
            members.append((key, value))
            skipWhitespace()
            guard pos < bytes.count else { throw JSONError(description: "unexpected end") }
            if bytes[pos] == 0x2C { pos += 1; continue }
            if bytes[pos] == 0x7D { pos += 1; return .object(members) }
            throw JSONError(description: "expected ',' or '}'")
        }
    }

    mutating func parseArray() throws -> JSONValue {
        pos += 1
        var items: [JSONValue] = []
        skipWhitespace()
        if pos < bytes.count, bytes[pos] == 0x5D { pos += 1; return .array(items) }
        while true {
            skipWhitespace()
            items.append(try parseValue())
            skipWhitespace()
            guard pos < bytes.count else { throw JSONError(description: "unexpected end") }
            if bytes[pos] == 0x2C { pos += 1; continue }
            if bytes[pos] == 0x5D { pos += 1; return .array(items) }
            throw JSONError(description: "expected ',' or ']'")
        }
    }

    mutating func parseNumber() throws -> String {
        let start = pos
        func digits() -> Int {
            let s = pos
            while pos < bytes.count, bytes[pos] >= 0x30, bytes[pos] <= 0x39 { pos += 1 }
            return pos - s
        }
        if pos < bytes.count, bytes[pos] == 0x2D { pos += 1 }
        guard pos < bytes.count else { throw JSONError(description: "invalid number") }
        if bytes[pos] == 0x30 {
            pos += 1
        } else if bytes[pos] >= 0x31, bytes[pos] <= 0x39 {
            _ = digits()
        } else {
            throw JSONError(description: "invalid value")
        }
        if pos < bytes.count, bytes[pos] == 0x2E {
            pos += 1
            guard digits() > 0 else { throw JSONError(description: "invalid fraction") }
        }
        if pos < bytes.count, bytes[pos] == 0x65 || bytes[pos] == 0x45 {
            pos += 1
            if pos < bytes.count, bytes[pos] == 0x2B || bytes[pos] == 0x2D { pos += 1 }
            guard digits() > 0 else { throw JSONError(description: "invalid exponent") }
        }
        return String(decoding: bytes[start..<pos], as: UTF8.self)
    }

    mutating func hex4() throws -> UInt32 {
        guard pos + 4 <= bytes.count else { throw JSONError(description: "short \\u escape") }
        var v: UInt32 = 0
        for _ in 0..<4 {
            let b = bytes[pos]
            let d: UInt32
            switch b {
            case 0x30...0x39: d = UInt32(b - 0x30)
            case 0x41...0x46: d = UInt32(b - 0x41 + 10)
            case 0x61...0x66: d = UInt32(b - 0x61 + 10)
            default: throw JSONError(description: "invalid \\u escape")
            }
            v = v * 16 + d
            pos += 1
        }
        return v
    }

    mutating func parseString() throws -> String {
        pos += 1
        var scalars = String.UnicodeScalarView()
        var runStart = pos
        func flushRun(_ p: Int) {
            if p > runStart, let s = UTF8Text.scalars(bytes[runStart..<p]) { scalars.append(contentsOf: s) }
        }
        while true {
            guard pos < bytes.count else { throw JSONError(description: "unterminated string") }
            let b = bytes[pos]
            if b == 0x22 {
                flushRun(pos)
                pos += 1
                return String(scalars)
            }
            if b < 0x20 { throw JSONError(description: "control character in a string") }
            if b != 0x5C { pos += 1; continue }
            flushRun(pos)
            pos += 1
            guard pos < bytes.count else { throw JSONError(description: "unterminated escape") }
            let e = bytes[pos]
            pos += 1
            switch e {
            case 0x22: scalars.append("\"")
            case 0x5C: scalars.append("\\")
            case 0x2F: scalars.append("/")
            case 0x62: scalars.append("\u{08}")
            case 0x66: scalars.append("\u{0C}")
            case 0x6E: scalars.append("\n")
            case 0x72: scalars.append("\r")
            case 0x74: scalars.append("\t")
            case 0x75:
                let u = try hex4()
                if (0xD800...0xDBFF).contains(u) {
                    // A high surrogate must be followed by an escaped low one.
                    if pos + 6 <= bytes.count, bytes[pos] == 0x5C, bytes[pos + 1] == 0x75 {
                        let save = pos
                        pos += 2
                        let low = try hex4()
                        if (0xDC00...0xDFFF).contains(low) {
                            scalars.append(Unicode.Scalar(0x10000 + ((u - 0xD800) << 10) + (low - 0xDC00))!)
                            break
                        }
                        pos = save
                    }
                    if options.iJSON { throw JSONError(description: "unpaired surrogate") }
                    scalars.append("\u{FFFD}")
                } else if (0xDC00...0xDFFF).contains(u) {
                    if options.iJSON { throw JSONError(description: "unpaired surrogate") }
                    scalars.append("\u{FFFD}")
                } else {
                    scalars.append(Unicode.Scalar(u)!)
                }
            default: throw JSONError(description: "invalid escape")
            }
            runStart = pos
        }
    }
}
