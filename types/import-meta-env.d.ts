/**
 * The build-time settings the browser adapters read, each one optional: a bundler such as Vite
 * fills `import.meta.env` from `VITE_*` environment variables; without one it is absent, and each
 * adapter falls back to its default loopback bridge address.
 */
interface ImportMetaEnv {
  readonly VITE_SIGNAL_BRIDGE_URL?: string;
  readonly VITE_MATRIX_BRIDGE_URL?: string;
  readonly VITE_EMAIL_BRIDGE_URL?: string;
}

interface ImportMeta {
  readonly env?: ImportMetaEnv;
}
