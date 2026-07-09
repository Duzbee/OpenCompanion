/**
 * Single source of the product identity ("OpenCompanion"). Every USER-VISIBLE brand surface - the CLI
 * usage banner + intro, the installed OS service label/description, the per-user app-data directory,
 * the daemon log file, and the standalone build artifacts - reads from here, so a future rename is one
 * edit to this file plus the install/build scripts (Phase 3), which hardcode these strings because
 * they run outside the TypeScript build and cannot import this module.
 *
 * WIRE IDENTITY IS DELIBERATELY NOT BRANDED. The device-authorization client id
 * (`DEFAULT_CLIENT_ID` in `backend-url.ts`, kept `'companion'`) and the monorepo package name
 * (`companion`) are frozen: deployed buyer backends allowlist exactly `'companion'` in their Better
 * Auth device grant, so renaming the wire id would break pairing against every existing deployment.
 * The brand is a presentation layer over a frozen protocol - never re-derive the client id from here.
 */
export const BRAND = {
  /** Product display name (intro banner, outros, service description). */
  name: 'OpenCompanion',
  /** The invoked binary / launcher name and the daemon log-file stem. */
  binary: 'opencompanion',
  /** Reverse-DNS service label / launchd + Windows-task identity (the `com.generatesaas` org prefix is retained). */
  serviceLabel: 'com.generatesaas.opencompanion',
  /** The per-user app-data directory name under each platform's data root. */
  appDirName: 'opencompanion',
  /** The public source + releases repository. */
  repoUrl: 'https://github.com/Duzbee/OpenCompanion',
  /** Base URL the install scripts download per-OS release artifacts (`opencompanion-<os>-<arch>`) from. */
  installBase: 'https://github.com/Duzbee/OpenCompanion/releases/latest/download'
} as const
