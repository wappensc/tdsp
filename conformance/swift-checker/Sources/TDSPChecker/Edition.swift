/// What names the edition of TDSP this checker reads, in one place: the version that frames and
/// invitations carry (FRM-2, §11.3), and the name the vector files carry for it. A draft of 2.0
/// wrote its marker in place of the version (VER-3), which is another version.
public enum Edition {
    /// FRM-2, §11.3: the version, as the digits an integer is written in (§1.6).
    public static let version = "2"

    /// The suffix of this edition's vector and wire files: `frames-<suffix>.json`.
    public static let fileSuffix = "v2"

    /// Whether a JSON value is the version: the integer written as `version`, not a string.
    static func isVersion(_ value: JSONValue?) -> Bool {
        if case .number(let lexeme)? = value { return lexeme == version }
        return false
    }

    /// A published test vector file of this edition, relative to the specification's directory.
    public static func vectors(_ name: String) -> String {
        "packages/document-protocol/test-vectors/\(name)-\(fileSuffix).json"
    }

    /// A wire file of this edition, relative to the specification's directory.
    public static func wire(_ name: String) -> String {
        "wire/\(name)-\(fileSuffix).json"
    }
}
