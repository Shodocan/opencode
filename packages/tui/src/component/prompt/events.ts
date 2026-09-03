type PromptAppendEvent = {
  text: string
  submit?: boolean
  sessionID?: string
}

type PromptSyntheticEvent = {
  text: string
  sessionID: string
  visible?: boolean
  caller?: string
}

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
