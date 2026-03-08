use neon::prelude::*;
use once_cell::sync::Lazy;
use tokio::runtime::Runtime;

// ---------------------------------------------------------------------------
// Shared tokio runtime — single instance per Node.js process lifetime.
// ---------------------------------------------------------------------------
static RUNTIME: Lazy<Runtime> = Lazy::new(|| {
    tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .expect("failed to build tokio runtime for moonstone-native")
});

// ---------------------------------------------------------------------------
// Sync validation helpers (rsky-syntax)
// ---------------------------------------------------------------------------

/// `validateHandle(handle: string): boolean`
fn validate_handle(mut cx: FunctionContext) -> JsResult<JsBoolean> {
    let handle = cx.argument::<JsString>(0)?.value(&mut cx);
    let ok = rsky_syntax::handle::is_valid_handle(&handle);
    Ok(cx.boolean(ok))
}

/// `ensureValidHandle(handle: string): void` — throws on invalid
fn ensure_valid_handle(mut cx: FunctionContext) -> JsResult<JsUndefined> {
    let handle = cx.argument::<JsString>(0)?.value(&mut cx);
    if let Err(e) = rsky_syntax::handle::ensure_valid_handle(&handle) {
        return cx.throw_error(e.to_string());
    }
    Ok(cx.undefined())
}

/// `validateDid(did: string): boolean`
fn validate_did(mut cx: FunctionContext) -> JsResult<JsBoolean> {
    let did = cx.argument::<JsString>(0)?.value(&mut cx);
    let ok = rsky_syntax::did::ensure_valid_did(&did).is_ok();
    Ok(cx.boolean(ok))
}

/// `ensureValidDid(did: string): void` — throws on invalid
fn ensure_valid_did(mut cx: FunctionContext) -> JsResult<JsUndefined> {
    let did = cx.argument::<JsString>(0)?.value(&mut cx);
    if let Err(e) = rsky_syntax::did::ensure_valid_did(&did) {
        return cx.throw_error(e.to_string());
    }
    Ok(cx.undefined())
}

/// `normalizeHandle(handle: string): string`
fn normalize_handle(mut cx: FunctionContext) -> JsResult<JsString> {
    let handle = cx.argument::<JsString>(0)?.value(&mut cx);
    let normalized = rsky_syntax::handle::normalize_handle(&handle);
    Ok(cx.string(normalized))
}

// ---------------------------------------------------------------------------
// Async identity resolution (rsky-identity)
// ---------------------------------------------------------------------------

/// `resolveDid(did: string, plcUrl: string, timeoutMs: number): Promise<object | null>`
///
/// Returns the raw DidDocument JSON or null if not found.
fn resolve_did(mut cx: FunctionContext) -> JsResult<JsPromise> {
    let did = cx.argument::<JsString>(0)?.value(&mut cx);
    let plc_url = cx.argument::<JsString>(1)?.value(&mut cx);
    let timeout_ms = cx.argument::<JsNumber>(2)?.value(&mut cx) as u64;

    let channel = cx.channel();
    let (deferred, promise) = cx.promise();

    RUNTIME.spawn(async move {
        use rsky_identity::{
            IdResolver,
            types::{DidCache, IdentityResolverOpts},
        };
        use std::time::Duration;

        let opts = IdentityResolverOpts {
            timeout: Some(Duration::from_millis(timeout_ms)),
            plc_url: Some(plc_url),
            did_cache: Some(DidCache::new(None, None)),
            backup_nameservers: None,
        };
        let mut resolver = IdResolver::new(opts);
        let result = resolver.did.resolve(did.clone(), None).await;

        deferred.settle_with(&channel, move |mut cx| match result {
            Err(e) => cx.throw_error(e.to_string()),
            Ok(None) => Ok(cx.null().upcast()),
            Ok(Some(doc)) => {
                let json = serde_json::to_string(&doc)
                    .map_err(|e| cx.error(e.to_string()).unwrap())?;
                let s = cx.string(json);
                // Return a parsed JS object by calling JSON.parse
                let json_global = cx.global::<JsObject>("JSON")?;
                let parse_fn = json_global.get::<JsFunction, _, _>(&mut cx, "parse")?;
                let result = parse_fn.call_with(&mut cx).arg(s).apply::<JsValue, _>(&mut cx)?;
                Ok(result)
            }
        });
    });

    Ok(promise)
}

/// `resolveHandle(handle: string, timeoutMs: number): Promise<string | null>`
///
/// Returns the DID string for the given handle, or null if unresolvable.
fn resolve_handle(mut cx: FunctionContext) -> JsResult<JsPromise> {
    let handle = cx.argument::<JsString>(0)?.value(&mut cx);
    let timeout_ms = cx.argument::<JsNumber>(1)?.value(&mut cx) as u64;

    let channel = cx.channel();
    let (deferred, promise) = cx.promise();

    RUNTIME.spawn(async move {
        use rsky_identity::{
            IdResolver,
            types::{DidCache, IdentityResolverOpts},
        };
        use std::time::Duration;

        let opts = IdentityResolverOpts {
            timeout: Some(Duration::from_millis(timeout_ms)),
            plc_url: None,
            did_cache: Some(DidCache::new(None, None)),
            backup_nameservers: None,
        };
        let mut resolver = IdResolver::new(opts);
        let result = resolver.handle.resolve(&handle).await;

        deferred.settle_with(&channel, move |mut cx| match result {
            Err(e) => cx.throw_error(e.to_string()),
            Ok(None) => Ok(cx.null().upcast()),
            Ok(Some(did)) => Ok(cx.string(did).upcast()),
        });
    });

    Ok(promise)
}

// ---------------------------------------------------------------------------
// Module registration
// ---------------------------------------------------------------------------
#[neon::main]
fn main(mut cx: ModuleContext) -> NeonResult<()> {
    cx.export_function("validateHandle", validate_handle)?;
    cx.export_function("ensureValidHandle", ensure_valid_handle)?;
    cx.export_function("validateDid", validate_did)?;
    cx.export_function("ensureValidDid", ensure_valid_did)?;
    cx.export_function("normalizeHandle", normalize_handle)?;
    cx.export_function("resolveDid", resolve_did)?;
    cx.export_function("resolveHandle", resolve_handle)?;
    Ok(())
}
