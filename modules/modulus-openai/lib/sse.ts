export async function* parseSseEvents(body: ReadableStream<Uint8Array>): AsyncIterable<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let dataLines: string[] = [];

  const dispatch = function* (): Iterable<string> {
    if (dataLines.length === 0) return;
    const data = dataLines.join('\n');
    dataLines = [];
    yield data;
  };

  const consumeLine = function* (rawLine: string): Iterable<string> {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    if (line === '') {
      yield* dispatch();
      return;
    }
    if (line.startsWith(':')) return;
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'data') dataLines.push(value);
  };

  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        for (const event of consumeLine(line)) yield event;
      }
    }
    buffer += decoder.decode();
    if (buffer) {
      for (const event of consumeLine(buffer)) yield event;
    }
    for (const event of dispatch()) yield event;
  } finally {
    await reader.cancel().catch(() => {});
  }
}

export async function* parseJsonSse<T = unknown>(
  body: ReadableStream<Uint8Array>,
): AsyncIterable<T> {
  for await (const event of parseSseEvents(body)) {
    if (event.trim() === '[DONE]') return;
    yield JSON.parse(event) as T;
  }
}
