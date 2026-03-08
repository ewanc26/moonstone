export enum AuthScope {
  Access             = 'com.atproto.access',
  Refresh            = 'com.atproto.refresh',
  AppPass            = 'com.atproto.appPass',
  AppPassPrivileged  = 'com.atproto.appPassPrivileged',
  Takendown          = 'com.atproto.takendown',
}

export const ACCESS_FULL       = [AuthScope.Access]              as const
export const ACCESS_PRIVILEGED = [...ACCESS_FULL, AuthScope.AppPassPrivileged] as const
export const ACCESS_STANDARD   = [...ACCESS_PRIVILEGED, AuthScope.AppPass]     as const

const scopeSet = new Set(Object.values(AuthScope))
export const isAuthScope = (v: unknown): v is AuthScope =>
  (scopeSet as Set<unknown>).has(v)

export const isAccessFull = (s: AuthScope) =>
  (ACCESS_FULL as readonly string[]).includes(s)

export const isAccessPrivileged = (s: AuthScope) =>
  (ACCESS_PRIVILEGED as readonly string[]).includes(s)

export const isTakendown = (s: unknown): s is AuthScope.Takendown =>
  s === AuthScope.Takendown
