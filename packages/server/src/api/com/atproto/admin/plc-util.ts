/**
 * Shared PLC helpers used across admin + identity routes.
 */
import * as plc from '@did-plc/lib'
import { InvalidRequestError } from '@atproto/xrpc-server'
import type { AppContext } from '../../../../context.js'

export async function updatePlcHandle(
  ctx: AppContext,
  did: string,
  handle: string,
): Promise<void> {
  const plcUrl = ctx.cfg.identity.plcUrl
  const lastOpResp = await fetch(`${plcUrl}/${did}/log/last`)
  if (!lastOpResp.ok) {
    throw new InvalidRequestError(`Could not fetch PLC last op: ${lastOpResp.status}`)
  }
  const lastOp = await lastOpResp.json() as plc.UnsignedOperation | plc.Tombstone
  if (plc.check.is(lastOp, plc.def.tombstone)) {
    throw new InvalidRequestError('DID is tombstoned')
  }
  const op = await plc.createUpdateOp(lastOp, ctx.plcRotationKey, (prev: any) => ({
    ...prev,
    alsoKnownAs: [`at://${handle}`],
  }))
  const sendResp = await fetch(`${plcUrl}/${did}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(op),
  })
  if (!sendResp.ok) {
    throw new InvalidRequestError(`PLC update failed: ${await sendResp.text()}`)
  }
}

export async function signPlcOp(
  ctx: AppContext,
  did: string,
  patch: {
    rotationKeys?: string[]
    alsoKnownAs?: string[]
    verificationMethods?: Record<string, string>
    services?: Record<string, { type: string; endpoint: string }>
  },
): Promise<plc.Operation> {
  const plcUrl = ctx.cfg.identity.plcUrl
  const lastOpResp = await fetch(`${plcUrl}/${did}/log/last`)
  if (!lastOpResp.ok) {
    throw new InvalidRequestError(`Could not fetch PLC last op: ${lastOpResp.status}`)
  }
  const lastOp = await lastOpResp.json() as plc.UnsignedOperation | plc.Tombstone
  if (plc.check.is(lastOp, plc.def.tombstone)) {
    throw new InvalidRequestError('DID is tombstoned')
  }
  return plc.createUpdateOp(lastOp, ctx.plcRotationKey, (prev: any) => ({
    ...prev,
    ...(patch.rotationKeys ? { rotationKeys: patch.rotationKeys } : {}),
    ...(patch.alsoKnownAs ? { alsoKnownAs: patch.alsoKnownAs } : {}),
    ...(patch.verificationMethods ? { verificationMethods: patch.verificationMethods } : {}),
    ...(patch.services ? { services: patch.services } : {}),
  }))
}
