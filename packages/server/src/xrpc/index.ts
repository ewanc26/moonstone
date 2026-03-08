import { Router } from 'express'
import type { AppContext } from '../context.js'
import { createIdentityOverrides } from './identity.js'

export function createXrpcOverrides(ctx: AppContext): Router {
  const router = Router()
  router.use(createIdentityOverrides(ctx))
  return router
}
