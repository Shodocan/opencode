export type HiddenPromptItem = {
  text: string
  visible?: boolean
  caller?: string
}

export type HiddenPromptDeliver = (item: HiddenPromptItem) => Promise<void>

export type HiddenPromptQueue = {
  enqueue(sessionID: string, item: HiddenPromptItem): void
  drain(sessionID: string, deliver: HiddenPromptDeliver): Promise<void>
}

export function createHiddenPromptQueue(): HiddenPromptQueue {
  const queues = new Map<string, HiddenPromptItem[]>()
  const inFlight = new Set<string>()

  async function _drain(sessionID: string, deliver: HiddenPromptDeliver): Promise<void> {
    if (inFlight.has(sessionID)) return
    const queue = queues.get(sessionID)
    if (!queue || queue.length === 0) return

    inFlight.add(sessionID)
    try {
      while (queue.length > 0) {
        const item = queue.shift()
        if (!item) continue
        await deliver(item).catch((error) => {
          console.error("failed to deliver hidden model prompt", error)
        })
      }
    } finally {
      inFlight.delete(sessionID)

      if (queue.length === 0) {
        queues.delete(sessionID)
      }

      if (queue.length > 0) {
        void _drain(sessionID, deliver)
      }
    }
  }

  return {
    enqueue(sessionID, item) {
      const queue = queues.get(sessionID) ?? []
      queue.push(item)
      queues.set(sessionID, queue)
    },
    drain(sessionID, deliver) {
      return _drain(sessionID, deliver)
    },
  }
}
