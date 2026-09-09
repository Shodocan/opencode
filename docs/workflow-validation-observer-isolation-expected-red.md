# Independent native validation failure notification isolation

The real ordered plugin chain loads a failing error observer, the real workflow
plugin, and a final proof recorder. The workflow claims its exact dispatch card.
The real native TaskTool wrapper then runs its real `prepare` method and rejects
an explicit model variant unavailable in the fixture provider catalog.

The session's tool metadata must contain affirmative native not-started proof.
No child creation or provider prompt may occur. The failing error observer must
not prevent later observers, especially the real workflow, from receiving that
proof. The workflow must durably record not-started, avoid acceptance/sealing,
and recover using public status without reconciliation. The original native
validation error must remain visible to the caller.

Only provider catalog and unrelated native services are controlled at service
boundaries. Task prepare/validation, Tool wrapper, SessionTools failure handling,
ordered native Plugin hooks, and workflow claim/recovery remain real. All files
are created inside disposable temporary test directories.

Expected RED after the before-chain-only repair: generic
`Plugin.trigger("tool.execute.error")` stops at the first failing observer, so
the workflow claim remains without terminal not-started evidence.

Seal: `a8dba1d87019c8cbb866245ad324c8babc6297da2b8fae9733696c932db4f594`.
Both author and source verifier independently reproduced the expected RED.
After the separate source repair, this test and all prior callback tests pass
alongside the original plugin suite: **193/193**, with every seal unchanged.
Log: `/tmp/native-plugin-callbacks-final-independent-green.log`.
Native package typecheck also passes.
