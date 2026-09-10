# Native background lifetime — independent test declaration

The persistent public HTTP canary already reproduced a normal parent stream
closure being mistaken for cancellation after background kickoff. Its scoped
AbortController is closed after the parent completes; it is not a user abort.

Before test creation, the focused expected RED is: after a real Task returns a
background kickoff, aborting that finished parent stream signal and then
allowing the child prompt to return normally must yield a completed native
receipt and background notification. Current source produces cancelled.

Controls will prove that explicit SessionRunState cancellation of parent or
child still stops the owned child runner and yields a cancelled receipt, and
that an abort during awaited startup prevents provider/prompt execution even
for a background request. Real Task, BackgroundJob, Session and SessionRunState
services are used; only the provider boundary and external plugin callback are
controlled with Deferred synchronization. No native source changes by author.
