import { Router } from 'express'
import type { AppContext } from '../../context.js'
import { mountServerRoutes } from './com/atproto/server/index.js'
import { mountRepoRoutes } from './com/atproto/repo/index.js'
import { mountSyncRoutes } from './com/atproto/sync/index.js'
import { mountAdminRoutes } from './com/atproto/admin/index.js'
import { mountModerationRoutes } from './com/atproto/moderation/index.js'
import { mountTempRoutes } from './com/atproto/temp/index.js'

export function buildApiRouter(ctx: AppContext): Router {
  const router = Router()
  mountServerRoutes(router, ctx)
  mountRepoRoutes(router, ctx)
  mountSyncRoutes(router, ctx)
  mountAdminRoutes(router, ctx)
  mountModerationRoutes(router, ctx)
  mountTempRoutes(router, ctx)
  return router
}

export { attachSubscribeRepos } from './com/atproto/sync/index.js'
