export default {
  id: "test.required-config-failure",
  configRequired: true,
  server: async () => ({
    config: async () => {
      throw new Error("invalid managed matrix")
    },
  }),
}
