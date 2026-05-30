import { Schema } from "effect"
import { TuiEvent } from "../../event"

type PromptAppendEvent = Schema.Schema.Type<typeof TuiEvent.PromptAppend.properties>
type PromptSyntheticEvent = Schema.Schema.Type<typeof TuiEvent.PromptSynthetic.properties>

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
