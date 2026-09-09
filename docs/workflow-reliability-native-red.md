# Native workflow reliability — expected RED

Before source changes, the common native tool path invokes only the success
after-hook; failed or interrupted admitted work skips the plugin's terminal
notification. The independent regression must observe an error callback with
the trusted caller identity and previously published child metadata, exactly
once, while preserving the original failure. Before-admission denial must never
execute the tool. A callback failure must remain visible.

Separately, Task must await a plugin child-binding callback before it begins a
child prompt. A rejected binding must produce zero prompts. Successful bindings
must precede both foreground and background execution, preserving the exact
selected provider/model/variant tuple and native parent/call/child identity.

Expected failure on base 7b06adb: error hooks are absent and Task starts work
without an awaited child binding. Provider error details are reduced to text.
No production source was changed when this expectation was recorded.
