import { Router } from 'express'
import type { AppContext } from '../../context.js'
import { mountServerRoutes } from './com/atproto/server/index.js'

export function buildApiRouter(ctx: AppContext): Router {
  const router = Router()
  mountServerRoutes(router, ctx)
  return router
}
