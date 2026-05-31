import { TuiEvent } from "../../event"

type PromptAppendEvent = typeof TuiEvent.PromptAppend.data.Type
type PromptSyntheticEvent = typeof TuiEvent.PromptSynthetic.data.Type

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
