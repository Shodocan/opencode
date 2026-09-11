export default {
  id: "test.optional-config-failure",
  server: async () => ({
    config: async () => {
      throw new Error("optional plugin failure")
    },
  }),
}
