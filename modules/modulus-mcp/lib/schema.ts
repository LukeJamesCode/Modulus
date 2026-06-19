// Map an MCP tool's inputSchema to a Modulus ToolHandler.parameters object.
//
// Both are JSON Schema, so this is normalization, not translation: guarantee a
// top-level object schema with a properties bag (what the orchestrator forwards
// to Ollama's tool manifest), carry `required` (filtered to strings), and supply
// a safe empty-object default when a server omits the schema. Nested property
// schemas — objects, arrays, enums — pass through untouched, so the model sees
// the server's real argument shape.

export function toToolParameters(inputSchema: unknown): Record<string, unknown> {
  if (!inputSchema || typeof inputSchema !== 'object') {
    return { type: 'object', properties: {} };
  }
  const s = inputSchema as Record<string, unknown>;
  const properties = s['properties'] && typeof s['properties'] === 'object' ? s['properties'] : {};
  const out: Record<string, unknown> = { type: 'object', properties };
  if (Array.isArray(s['required'])) {
    const required = s['required'].filter((r): r is string => typeof r === 'string');
    if (required.length > 0) out['required'] = required;
  }
  return out;
}
