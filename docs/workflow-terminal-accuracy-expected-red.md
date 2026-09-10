# Native terminal accuracy and cancellation ordering expected RED

Recorded before test writing/source fixes by independent test author identity_runtime_audit.

Task must preserve returned APIError as provider evidence but remoteOutcome unknown without valid HTTP response status. Returned UnknownError is tool evidence. Returned MessageAbortedError is cancellation even without parent abort and must not charge provider fallback. Successful output and definitive HTTP response/tool error remain completed remote outcomes.

BackgroundJob must not acknowledge concurrent cancel/wait while owned scope cleanup is in flight. SessionRunState must stop its live runner before final descendant enumeration so no late spawned job survives acknowledgement.

Expected RED: Task currently sets remoteOutcome completed before inspecting error and labels all assistant errors provider. BackgroundJob publishes cancelled and resolves done before Scope.close; second cancel bypasses cleanup. SessionRunState enumerates jobs once before stopping its runner. Tests use real services and deterministic Deferred gates; only Task prompt/provider and external plugin hooks are stubbed. No sleeps/source edits by author. Source implementer independently confirms RED. Tests sealed after meaningful author RED.
