import { Request, Response, NextFunction } from 'express'
import { AuthRequiredError } from '@atproto/xrpc-server'
import crypto from 'node:crypto'
import {
  verifyAccessToken,
  verifyRefreshToken,
  AccessTokenPayload,
  RefreshTokenPayload,
} from './jwt.js'
import { AuthScope, isTakendown } from './scope.js'
import { AccountManager } from '../account-manager/index.js'

export type AuthOutput =
  | { type: 'access'; credentials: AccessTokenPayload & { did: string } }
  | { type: 'refresh'; credentials: RefreshTokenPayload & { did: string; tokenId: string } }
  | { type: 'admin' }

export class AuthVerifier {
  constructor(
    private jwtKey: crypto.KeyObject,
    private serviceDid: string,
    private adminPassword: string,
    private accountManager: AccountManager,
  ) {}

  // ---------- middleware helpers ----------

  /** Require a valid access token. Sets res.locals.auth. */
  accessToken = async (
    req: Request,
    res: Response,
    next: NextFunction,
    opts: { checkTakedown?: boolean; allowedScopes?: AuthScope[] } = {},
  ) => {
    try {
      const token = extractBearer(req)
      const payload = await verifyAccessToken(token, this.jwtKey, this.serviceDid)
      if (opts.checkTakedown && isTakendown(payload.scope)) {
        throw new AuthRequiredError('Account has been taken down', 'AccountTakedown')
      }
      if (opts.allowedScopes && !opts.allowedScopes.includes(payload.scope)) {
        throw new AuthRequiredError('Insufficient token scope', 'InvalidToken')
      }
      res.locals.auth = {
        type: 'access',
        credentials: { ...payload, did: payload.sub },
      }
      next()
    } catch (err) {
      next(new AuthRequiredError('Invalid or missing token'))
    }
  }

  /** Require a valid refresh token. Sets res.locals.auth. */
  refreshToken = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const token = extractBearer(req)
      const payload = await verifyRefreshToken(token, this.jwtKey, this.serviceDid)
      res.locals.auth = {
        type: 'refresh',
        credentials: { ...payload, did: payload.sub, tokenId: payload.jti },
      }
      next()
    } catch {
      next(new AuthRequiredError('Invalid or missing refresh token'))
    }
  }

  /** Require admin Basic auth. Sets res.locals.auth. */
  adminToken = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { password } = extractBasic(req)
      if (!timingSafeEqual(password, this.adminPassword)) {
        throw new AuthRequiredError('Invalid admin credentials')
      }
      res.locals.auth = { type: 'admin' }
      next()
    } catch {
      next(new AuthRequiredError('Admin auth required'))
    }
  }

  /** Access token but does not throw if missing — sets res.locals.auth = null. */
  accessTokenOptional = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const token = extractBearer(req)
      const payload = await verifyAccessToken(token, this.jwtKey, this.serviceDid)
      res.locals.auth = {
        type: 'access',
        credentials: { ...payload, did: payload.sub },
      }
    } catch {
      res.locals.auth = null
    }
    next()
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function extractBearer(req: Request): string {
  const header = req.headers.authorization
  if (!header?.startsWith('Bearer ')) {
    throw new AuthRequiredError('Missing bearer token')
  }
  return header.slice(7)
}

function extractBasic(req: Request): { user: string; password: string } {
  const header = req.headers.authorization
  if (!header?.startsWith('Basic ')) {
    throw new AuthRequiredError('Missing basic auth')
  }
  const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8')
  const colon = decoded.indexOf(':')
  if (colon < 0) throw new AuthRequiredError('Malformed basic auth')
  return { user: decoded.slice(0, colon), password: decoded.slice(colon + 1) }
}

function timingSafeEqual(a: string, b: string): boolean {
  // Constant-time comparison even for unequal lengths.
  const bufA = Buffer.from(a)
  const bufB = Buffer.from(b)
  if (bufA.length !== bufB.length) {
    // Still do a comparison to avoid timing side-channel on length.
    crypto.timingSafeEqual(bufA, bufA)
    return false
  }
  return crypto.timingSafeEqual(bufA, bufB)
}
