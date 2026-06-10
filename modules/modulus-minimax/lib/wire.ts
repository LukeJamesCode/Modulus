import type { ChatMessage, ToolSchema, ToolCall } from '../../../src/core/llm.js';

export interface MinimaxMessage {
  role: string;
  content: string;
  name?: string;
  tool_call_id?: string;
  tool_calls?: Array<{
    id: string;
    type: 'function';
    function: {
      name: string;
      arguments: string;
    };
  }>;
}

export function toMinimaxMessages(messages: readonly ChatMessage[]): MinimaxMessage[] {
  return messages.map((m) => {
    const out: MinimaxMessage = {
      role: m.role,
      content: m.content || '',
    };
    if (m.tool_name) out.name = m.tool_name;
    if (m.tool_call_id) out.tool_call_id = m.tool_call_id;
    if (m.tool_calls && m.tool_calls.length > 0) {
      out.tool_calls = m.tool_calls.map((tc) => ({
        id: tc.id,
        type: 'function',
        function: {
          name: tc.name,
          arguments: JSON.stringify(tc.arguments),
        },
      }));
    }
    return out;
  });
}

export interface MinimaxTool {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export function toMinimaxTools(tools?: readonly ToolSchema[]): MinimaxTool[] | undefined {
  if (!tools || tools.length === 0) return undefined;
  return tools.map((t) => ({
    type: 'function',
    function: {
      name: t.function.name,
      description: t.function.description,
      parameters: t.function.parameters,
    },
  }));
}

export function parseMinimaxToolCalls(
  rawToolCalls:
    | Array<{ id?: string; function?: { name?: string; arguments?: string } }>
    | undefined,
): ToolCall[] | undefined {
  if (!rawToolCalls || rawToolCalls.length === 0) return undefined;

  const out: ToolCall[] = [];
  for (const [i, tc] of rawToolCalls.entries()) {
    if (!tc.function || !tc.function.name) continue;
    let parsedArgs: Record<string, unknown> = {};
    if (tc.function.arguments) {
      try {
        parsedArgs = JSON.parse(tc.function.arguments);
      } catch {
        // Fallback to empty object if unparseable
      }
    }
    out.push({
      id: tc.id ?? `call_${i}_${Date.now()}`,
      name: tc.function.name,
      arguments: parsedArgs,
    });
  }
  return out.length > 0 ? out : undefined;
}
