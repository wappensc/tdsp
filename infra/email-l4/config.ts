import { existsSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * L4 for the email adapter (docs/testing.md): two real mailboxes at a real
 * provider. Unlike `infra/email-testserver/config.ts`'s fixed Greenmail accounts,
 * these are real credentials, so this file invents no default for any of them —
 * everything comes from the gitignored `credentials/.env.l4.email` (shape:
 * `.env.l4.email.example`) or from environment variables of the same name, which
 * win. Only this machine ever reads them; nothing here talks to the network.
 *
 * Kept as plain Node with no workspace imports, like the rest of `infra/`.
 */
export const EMAIL_L4_ENV_FILE = fileURLToPath(
  new URL("./credentials/.env.l4.email", import.meta.url),
);

export interface L4MailServer {
  readonly host: string;
  readonly port: number;
  /** `true`: implicit TLS. `false`: STARTTLS, which the bridge requires — plaintext does not exist for a remote host. */
  readonly secure: boolean;
}

export interface L4MailAccount {
  readonly address: string;
  /** The login; the address itself unless the provider says otherwise. */
  readonly authUser: string;
  readonly pass: string;
  readonly smtp: L4MailServer;
  readonly imap: L4MailServer;
}

export interface EmailL4Config {
  /** Plays the creator ("Alice"). */
  readonly a: L4MailAccount;
  /** Plays the participant who joins ("Bob"). */
  readonly b: L4MailAccount;
}

export type EmailL4Status =
  | { readonly state: "absent" }
  | { readonly state: "invalid"; readonly problems: readonly string[] }
  | { readonly state: "ready"; readonly config: EmailL4Config };

/** `KEY=VALUE` lines; `#` comments and blank lines ignored; one pair of matching quotes around a value is removed. */
export function parseEnvFile(text: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) {
      continue;
    }
    const equals = line.indexOf("=");
    if (equals <= 0) {
      continue;
    }
    const key = line.slice(0, equals).trim();
    let value = line.slice(equals + 1).trim();
    if (value.length >= 2 && (value[0] === '"' || value[0] === "'") && value.at(-1) === value[0]) {
      value = value.slice(1, -1);
    }
    values[key] = value;
  }
  return values;
}

function readAccount(
  role: "A" | "B",
  get: (name: string) => string | undefined,
  problems: string[],
): L4MailAccount | undefined {
  const name = (suffix: string) => `L4_MAIL_${role}_${suffix}`;
  const before = problems.length;
  const required = (suffix: string): string => {
    const value = get(name(suffix));
    if (!value) {
      problems.push(`${name(suffix)} is not set`);
    }
    return value ?? "";
  };
  const server = (kind: "SMTP" | "IMAP"): L4MailServer => {
    const host = required(`${kind}_HOST`);
    const portText = required(`${kind}_PORT`);
    const secureText = required(`${kind}_SECURE`);
    const port = Number(portText);
    if (portText && !(Number.isInteger(port) && port > 0 && port < 65536)) {
      problems.push(`${name(`${kind}_PORT`)} must be a port number, got "${portText}"`);
    }
    if (secureText && secureText !== "true" && secureText !== "false") {
      problems.push(`${name(`${kind}_SECURE`)} must be "true" or "false", got "${secureText}"`);
    }
    const secure = secureText === "true";
    // The two commonest mistakes, caught here rather than as a baffling handshake failure.
    if (secureText === "false" && (port === 465 || port === 993)) {
      problems.push(
        `${name(`${kind}_SECURE`)}=false on port ${port}, which speaks implicit TLS — set it to "true"`,
      );
    }
    if (secureText === "true" && (port === 587 || port === 143)) {
      problems.push(
        `${name(`${kind}_SECURE`)}=true on port ${port}, which speaks STARTTLS — set it to "false" (the bridge then requires STARTTLS)`,
      );
    }
    return { host, port, secure };
  };
  const address = required("ADDRESS");
  const pass = required("PASS");
  const smtp = server("SMTP");
  const imap = server("IMAP");
  if (address && !/^[^\s@<>,;"]+@[^\s@<>,;"]+$/.test(address)) {
    problems.push(`${name("ADDRESS")} is not a single email address`);
  }
  if (problems.length > before) {
    return undefined;
  }
  return { address, authUser: get(name("AUTH_USER")) || address, pass, smtp, imap };
}

/**
 * What the L4 configuration is right now: `absent` (nothing set — the L4 specs
 * skip, like every live spec without its server), `invalid` (something is set
 * and wrong — named, so that a typo is not mistaken for "not configured"), or
 * `ready`. Never throws and never reads the network.
 */
export function emailL4Status(
  options: { env?: NodeJS.ProcessEnv; file?: string } = {},
): EmailL4Status {
  const env = options.env ?? process.env;
  const file = options.file ?? EMAIL_L4_ENV_FILE;
  const problems: string[] = [];
  let fromFile: Record<string, string> = {};
  if (existsSync(file)) {
    // A real password in a file others can read is a leak in waiting.
    if ((statSync(file).mode & 0o077) !== 0) {
      problems.push(`${file} is readable by other users — run: chmod 600 ${file}`);
    }
    fromFile = parseEnvFile(readFileSync(file, "utf8"));
  }
  const get = (key: string): string | undefined => {
    const fromEnv = env[key];
    return fromEnv !== undefined && fromEnv !== "" ? fromEnv : fromFile[key] || undefined;
  };
  const anySet = ["A", "B"].some((role) =>
    ["ADDRESS", "PASS"].some((suffix) => get(`L4_MAIL_${role}_${suffix}`) !== undefined),
  );
  if (!anySet && problems.length === 0) {
    return { state: "absent" };
  }
  const a = readAccount("A", get, problems);
  const b = readAccount("B", get, problems);
  if (a && b && a.address.toLowerCase() === b.address.toLowerCase()) {
    problems.push("account A and account B must be two different mailboxes");
  }
  if (problems.length > 0 || !a || !b) {
    return { state: "invalid", problems };
  }
  return { state: "ready", config: { a, b } };
}

/** The gate every email L4 spec checks first: real credentials are opt-in, never assumed present. */
export function hasEmailL4Credentials(): boolean {
  return emailL4Status().state === "ready";
}
