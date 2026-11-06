// The invitation as a link (§11.3, INV-6, INV-10): an application/x-www-form-urlencoded query
// as the WHATWG URL standard reads it, with the parameters of §11.3's table.

public enum InvitationResult {
    case valid(JSONValue)
    /// A problem as §11.3 names it (INV-6), and a detail.
    case refused(String, String)
}

public enum InvitationReader {
    static let defined: Set<String> = ["tdsp", "provider", "documentId", "creatorMemberId", "channelId",
                                       "threadRoot", "recipients", "pgp", "profile"]

    /// WHATWG URL, "application/x-www-form-urlencoded parsing": split on `&`, the name before
    /// the first `=`, `+` as a space, percent-decoding to bytes, then UTF-8 decoding without BOM
    /// or failure (an invalid sequence becomes U+FFFD).
    public static func formDecode(_ query: String) -> [(String, String)] {
        var out: [(String, String)] = []
        for sequence in query.utf8.split(separator: 0x26, omittingEmptySubsequences: true) {
            let bytes = Array(sequence)
            let eq = bytes.firstIndex(of: 0x3D)
            let name = eq.map { Array(bytes[..<$0]) } ?? bytes
            let value = eq.map { Array(bytes[($0 + 1)...]) } ?? []
            out.append((percentDecode(name), percentDecode(value)))
        }
        return out
    }

    static func percentDecode(_ input: [UInt8]) -> String {
        var bytes: [UInt8] = []
        var i = 0
        func hexValue(_ c: UInt8) -> UInt8? {
            switch c {
            case 0x30...0x39: return c - 0x30
            case 0x41...0x46: return c - 0x41 + 10
            case 0x61...0x66: return c - 0x61 + 10
            default: return nil
            }
        }
        while i < input.count {
            let c = input[i]
            if c == 0x2B {
                bytes.append(0x20)
            } else if c == 0x25, i + 2 < input.count, let h = hexValue(input[i + 1]), let l = hexValue(input[i + 2]) {
                bytes.append(h << 4 | l)
                i += 2
            } else {
                bytes.append(c)
            }
            i += 1
        }
        return String(decoding: bytes, as: UTF8.self)
    }

    /// The thread root of the email binding: `<local@domain>`, at most 200 characters, the
    /// local part from `[A-Za-z0-9._~+-]` and the domain from `[A-Za-z0-9.-]`.
    static func isMessageId(_ s: String) -> Bool {
        let b = Array(s.utf8)
        guard s.codePointCount <= 200, b.count >= 5, b.first == 0x3C, b.last == 0x3E else { return false }
        let inner = b[1..<(b.count - 1)]
        guard let at = inner.firstIndex(of: 0x40) else { return false }
        let local = inner[..<at], domain = inner[(at + 1)...]
        func alnum(_ c: UInt8) -> Bool { (0x41...0x5A).contains(c) || (0x61...0x7A).contains(c) || (0x30...0x39).contains(c) }
        return !local.isEmpty && !domain.isEmpty
            && local.allSatisfy { alnum($0) || [0x2E, 0x5F, 0x7E, 0x2B, 0x2D].contains($0) }
            && domain.allSatisfy { alnum($0) || [0x2E, 0x2D].contains($0) }
    }

    /// The binding's name: lowercase letters, digits, `.` and `-`, 1 to 64 characters, the
    /// first a letter or a digit.
    static func isProvider(_ s: String) -> Bool {
        let b = Array(s.utf8)
        func start(_ c: UInt8) -> Bool { (0x61...0x7A).contains(c) || (0x30...0x39).contains(c) }
        return (1...64).contains(b.count) && start(b[0]) && b.allSatisfy { start($0) || $0 == 0x2E || $0 == 0x2D }
    }

    static func isBytes1to255(_ s: String) -> Bool { (1...255).contains(s.utf8Length) }

    /// White space as ECMAScript's `\s` matches it (§11.3, `recipients`).
    static func isECMAScriptSpace(_ u: UInt16) -> Bool {
        switch u {
        case 0x09...0x0D, 0x20, 0xA0, 0x1680, 0x2000...0x200A, 0x2028, 0x2029, 0x202F, 0x205F, 0x3000, 0xFEFF: return true
        default: return false
        }
    }

    /// One address of `recipients` (§11.3): a local part of 1–64 and a domain of 1–189 UTF-16
    /// code units joined by `@`, neither holding `,`, `@` or white space.
    static func isAddress(_ s: String) -> Bool {
        let units = Array(s.utf16)
        guard let at = units.firstIndex(of: 0x40) else { return false }
        let local = units[..<at], domain = units[(at + 1)...]
        func plain(_ part: ArraySlice<UInt16>) -> Bool { part.allSatisfy { $0 != 0x2C && $0 != 0x40 && !isECMAScriptSpace($0) } }
        return (1...64).contains(local.count) && (1...189).contains(domain.count) && plain(local) && plain(domain)
    }

    /// INV-6: the first problem that applies, in the order §11.3 gives.
    public static func read(_ query: String) -> InvitationResult {
        let params = formDecode(query)
        var values: [String: String] = [:]
        var repeated: [String] = []
        for (name, value) in params where defined.contains(name) {
            if values[name] != nil { repeated.append(name) }
            values[name] = value
        }
        if let r = repeated.first { return .refused("repeated-field", "\(r) more than once") }
        if values["tdsp"] == nil && values["documentId"] == nil {
            return .refused("not-an-invitation", "neither tdsp nor documentId")
        }
        guard values["tdsp"] == Edition.version else {
            return .refused("unsupported-version", "tdsp is \(values["tdsp"] ?? "missing")")
        }
        for name in ["provider", "documentId", "creatorMemberId", "profile"] where (values[name] ?? "").isEmpty {
            return .refused("missing-field", name)
        }
        let provider = values["provider"]!
        guard isProvider(provider) else { return .refused("invalid-field", "provider \(provider)") }
        for name in ["documentId", "creatorMemberId", "channelId"] {
            if let v = values[name], !isBytes1to255(v) { return .refused("invalid-field", name) }
        }
        guard ProfileId.isValid(values["profile"]!) else { return .refused("invalid-field", "profile") }
        if let root = values["threadRoot"], !isMessageId(root) { return .refused("invalid-field", "threadRoot") }
        var recipients: [String]?
        if let list = values["recipients"] {
            let addresses = list.split(separator: ",", omittingEmptySubsequences: false).map(String.init)
            guard (1...64).contains(addresses.count), addresses.allSatisfy(isAddress),
                  Set(addresses.map { $0.lowercased() }).count == addresses.count else {
                return .refused("invalid-field", "recipients")
            }
            recipients = addresses
        }
        if let pgp = values["pgp"], pgp != "1" { return .refused("invalid-field", "pgp") }
        // Email requires its thread and recipients; every other binding a channel.
        let bindingNeeds = provider == "email" ? ["threadRoot", "recipients"] : ["channelId"]
        for name in bindingNeeds where values[name] == nil { return .refused("missing-field", name) }

        // Every parameter of the table that is present is read, whichever binding it belongs to.
        var invitation: [(String, JSONValue)] = [
            ("messenger", .string(provider)),
            ("documentId", .string(values["documentId"]!)),
            ("creatorMemberId", .string(values["creatorMemberId"]!)),
            ("profile", .string(values["profile"]!)),
        ]
        if let channel = values["channelId"] { invitation.append(("channelId", .string(channel))) }
        if let root = values["threadRoot"] { invitation.append(("threadRoot", .string(root))) }
        if let recipients { invitation.append(("recipients", .array(recipients.map { .string($0) }))) }
        if values["pgp"] != nil { invitation.append(("pgp", .bool(true))) }
        return .valid(.object(invitation))
    }
}
