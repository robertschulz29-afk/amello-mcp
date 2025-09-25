// api/_lib/amelloTools.js
// Minimal tool so you can verify the plumbing works.

export function registerAmelloTools(server) {
  server.registerTool(
    {
      name: "ping",
      description: "Health check: returns pong",
      inputSchema: { type: "object", additionalProperties: false, properties: {} },
      outputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          ok: { type: "boolean", description: "True if the server is alive" },
          message: { type: "string", description: "Human-readable status" }
        },
        required: ["ok", "message"]
      }
    },
    async () => {
      return {
        content: [{ type: "text", text: "pong" }],
        structuredContent: { ok: true, message: "pong" }
      };
    }
  );
}
