# Native Task claim followed by another plugin's admission failure

The real workflow plugin can durably claim a Task in its before hook before a
later installed plugin rejects that same native call. Native execution has not
started, so the runtime must publish a trustworthy not-started failure receipt.
That receipt releases the claimed workflow attempt without creating a child,
issuing a provider request, or accepting any worker result. Existing rejection
before any claim remains fail-closed and grants no execution authority.

Expected RED: native SessionTools attaches its failure observer only after the
entire before-hook chain returns; a later before-hook exception strands the
already-claimed workflow attempt running/unbound. The test uses the real ordered
Plugin service, real workflow plugin/journal, and public workflow start/status;
the Task execution body is a bounded counter and must never run.
