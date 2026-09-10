# Targeted native status — test declaration

Approved additive contract: GET /session/status?sessionID=<exact ID> validates
that the persisted session exists in the requested native instance and returns
only its exact live status. No-query status retains its historical sparse map.
Missing or wrong-instance sessions must not be reported idle.

Expected RED before test creation: current schema ignores sessionID and the
handler returns only the sparse map; idle target returns {}, missing/foreign
targets return 200, and a busy target can leak other sparse entries.

Tests use the real HttpApi server and public session.create. Runtime status
transitions use the actual native service, not a status mock. Source belongs
to the separate native implementer.

Sealed test SHA256: `96d03e62af78a2f6a6dd86c1b882342312a2f98fc4b99187266168a9e5d42ab6`.
Author RED: 0 passed / 4 failed, all four expected status-contract assertions;
`/tmp/native-targeted-status-author-red.log`. Independent source author owns GREEN.

After separate source implementation, this author reran the unmodified status
and SDK suites: 11 passed / 0 failed, 37 assertions, in
`/tmp/native-targeted-sdk-author-green.log`; all four sealed native hashes match.
