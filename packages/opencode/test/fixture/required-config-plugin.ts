export default {
  id: "test.required-config",
  configRequired: true,
  server: async () => ({
    config: async (config: { agent?: Record<string, unknown> }) => {
      config.agent ??= {}
      config.agent.required_config_agent = {
        description: "Registered by a required config hook",
        mode: "subagent",
      }
    },
  }),
}
