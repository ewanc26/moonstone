import crypto from 'node:crypto'
import * as jose from 'jose'
import * as ui8 from 'uint8arrays'
import * as atCrypto from '@atproto/crypto'
import { AuthScope, isAuthScope } from './scope.js'

// ---------------------------------------------------------------------------
// Key creation
// ---------------------------------------------------------------------------

export function makeJwtKey(secret: string): crypto.KeyObject {
  return crypto.createSecretKey(Buffer.from(secret))
}

// ---------------------------------------------------------------------------
// Token creation
// ---------------------------------------------------------------------------

export type RefreshTokenPayload = {
  scope: AuthScope.Refresh
  sub: string
  aud: string
  exp: number
  jti: string
}

export const createTokens = async (opts: {
  did: string
  jwtKey: crypto.KeyObject
  serviceDid: string
  scope?: AuthScope
  jti?: string
  expiresIn?: string | number
}) => {
  const { did, jwtKey, serviceDid, scope, jti, expiresIn } = opts
  const [accessJwt, refreshJwt] = await Promise.all([
    createAccessToken({ did, jwtKey, serviceDid, scope, expiresIn }),
    createRefreshToken({ did, jwtKey, serviceDid, jti }),
  ])
  return { accessJwt, refreshJwt }
}

export const createAccessToken = (opts: {
  did: string
  jwtKey: crypto.KeyObject
  serviceDid: string
  scope?: AuthScope
  expiresIn?: string | number
}): Promise<string> => {
  const { did, jwtKey, serviceDid, scope = AuthScope.Access, expiresIn = '120mins' } = opts
  return new jose.SignJWT({ scope })
    .setProtectedHeader({ typ: 'at+jwt', alg: 'HS256' })
    .setAudience(serviceDid)
    .setSubject(did)
    .setIssuedAt()
    .setExpirationTime(expiresIn)
    .sign(jwtKey)
}

export const createRefreshToken = (opts: {
  did: string
  jwtKey: crypto.KeyObject
  serviceDid: string
  jti?: string
  expiresIn?: string | number
}): Promise<string> => {
  const { did, jwtKey, serviceDid, jti = getRefreshTokenId(), expiresIn = '90days' } = opts
  return new jose.SignJWT({ scope: AuthScope.Refresh })
    .setProtectedHeader({ typ: 'refresh+jwt', alg: 'HS256' })
    .setAudience(serviceDid)
    .setSubject(did)
    .setJti(jti)
    .setIssuedAt()
    .setExpirationTime(expiresIn)
    .sign(jwtKey)
}

// ---------------------------------------------------------------------------
// Verification
// ---------------------------------------------------------------------------

export type AccessTokenPayload = {
  sub: string
  scope: AuthScope
  exp: number
}

export const verifyAccessToken = async (
  token: string,
  jwtKey: crypto.KeyObject,
  serviceDid: string,
): Promise<AccessTokenPayload> => {
  const { payload } = await jose.jwtVerify(token, jwtKey, {
    audience: serviceDid,
    typ: 'at+jwt',
  })
  const scope = payload['scope']
  if (!isAuthScope(scope)) throw new Error('Invalid token scope')
  if (!payload.sub) throw new Error('Missing sub claim')
  return { sub: payload.sub, scope, exp: payload.exp as number }
}

export const verifyRefreshToken = async (
  token: string,
  jwtKey: crypto.KeyObject,
  serviceDid: string,
): Promise<RefreshTokenPayload> => {
  const { payload } = await jose.jwtVerify(token, jwtKey, {
    audience: serviceDid,
    typ: 'refresh+jwt',
  })
  if (payload['scope'] !== AuthScope.Refresh) throw new Error('Not a refresh token')
  if (!payload.sub || !payload.jti) throw new Error('Missing claims')
  return {
    scope: AuthScope.Refresh,
    sub: payload.sub,
    aud: serviceDid,
    exp: payload.exp as number,
    jti: payload.jti,
  }
}

export const decodeRefreshToken = (jwt: string): RefreshTokenPayload => {
  const payload = jose.decodeJwt(jwt)
  if (payload['scope'] !== AuthScope.Refresh) throw new Error('Not a refresh token')
  return payload as unknown as RefreshTokenPayload
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

export const getRefreshTokenId = (): string =>
  ui8.toString(atCrypto.randomBytes(32), 'base64')

export const formatScope = (
  appPassword: { name: string; privileged: boolean } | null,
  isSoftDeleted = false,
): AuthScope => {
  if (isSoftDeleted) return AuthScope.Takendown
  if (!appPassword) return AuthScope.Access
  return appPassword.privileged ? AuthScope.AppPassPrivileged : AuthScope.AppPass
}
