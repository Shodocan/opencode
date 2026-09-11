export default {
  id: "test.required-startup-failure",
  configRequired: true,
  server: async () => {
    throw new Error("required plugin startup failed")
  },
}
