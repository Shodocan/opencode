import type z from "zod"
import { TuiEvent } from "../../event"

type PromptAppendEvent = z.infer<typeof TuiEvent.PromptAppend.properties>
type PromptSyntheticEvent = z.infer<typeof TuiEvent.PromptSynthetic.properties>

export function createPromptEventHandlers(input: {
  sessionID: () => string | undefined
  onAppend: (event: PromptAppendEvent) => void
  onSynthetic: (event: PromptSyntheticEvent) => void
}) {
  return {
    onAppend(event: PromptAppendEvent) {
      if (event.sessionID && event.sessionID !== input.sessionID()) return
      input.onAppend(event)
    },
    onSynthetic(event: PromptSyntheticEvent) {
      input.onSynthetic(event)
    },
  }
}
