/**
 * Public surface of `@opencompanion/core-types`: the pure, dependency-light backend-contract
 * types + the small declarative model fallback, extracted from `@opencompanion/core` so a
 * web-only, AI-enabled buyer pulling `@repo/ai` never installs the process/SDK machinery
 * (and the platform-specific agentic-CLI SDK binaries) that `@opencompanion/core` carries.
 *
 * This package depends on nothing but `@opencompanion/protocol` (the AI wire vocabulary).
 * `@opencompanion/core` re-exports everything here so its own consumers change no imports, and
 * `@repo/ai/backends` + `@repo/ai/discovery` import directly from here.
 */

export * from './types'
export { FALLBACK_MODELS } from './fallback-models'
