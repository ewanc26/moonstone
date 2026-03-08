/**
 * @moonstone/native — type declarations for the Rust native addon.
 *
 * The addon is compiled from Rust (neon) and ships as `index.node`.
 * These types mirror the exported functions in packages/native/src/lib.rs.
 */

/** Returns true if the handle is syntactically valid (rsky-syntax). */
export declare function validateHandle(handle: string): boolean

/**
 * Throws a JS Error if the handle is invalid. Use in fast validation paths.
 */
export declare function ensureValidHandle(handle: string): void

/** Returns true if the DID is syntactically valid (rsky-syntax). */
export declare function validateDid(did: string): boolean

/** Throws a JS Error if the DID is invalid. */
export declare function ensureValidDid(did: string): void

/** Normalises a handle to lowercase. */
export declare function normalizeHandle(handle: string): string

/**
 * Resolves a DID to its DID Document.
 * Supports did:plc (via the given plcUrl) and did:web.
 * Returns null if the DID is not found.
 */
export declare function resolveDid(
  did: string,
  plcUrl: string,
  timeoutMs: number,
): Promise<Record<string, unknown> | null>

/**
 * Resolves a handle to its DID string.
 * Tries DNS TXT (_atproto.<handle>), then HTTP (/.well-known/atproto-did).
 * Returns null if unresolvable.
 */
export declare function resolveHandle(
  handle: string,
  timeoutMs: number,
): Promise<string | null>
