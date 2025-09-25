export function registerAmelloTools(server) {
  // Example:
  server.registerTool(
    { name: "ping", description: "health check", inputSchema: { type: "object", properties: {} }, outputSchema: { type: "object", properties: { ok: { type: "boolean" } } } },
    async () => ({ content: [{ type: "text", text: "pong" }], structuredContent: { ok: true } })
  );
  // ... your real tools
}
