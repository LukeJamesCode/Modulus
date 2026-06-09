// Tints all CLI output green when stdout/stderr is a TTY. Imported for
// side-effects from the CLI entrypoint so every subcommand — and any library
// that writes to stdout/stderr (commander, inquirer, the structured logger
// when `modulus start` runs in the foreground) — comes out green.
//
// Skipped when NO_COLOR is set or the stream isn't a TTY, so piped output
// (e.g. `modulus logs > file`) stays plain.

const GREEN = '\x1b[32m';
const RESET = '\x1b[0m';

function shouldColor(stream: NodeJS.WriteStream): boolean {
  if (process.env['NO_COLOR']) return false;
  return !!stream.isTTY;
}

function paint(chunk: unknown): unknown {
  if (typeof chunk === 'string') {
    if (chunk.length === 0) return chunk;
    return GREEN + chunk + RESET;
  }
  if (Buffer.isBuffer(chunk)) {
    if (chunk.length === 0) return chunk;
    return Buffer.concat([Buffer.from(GREEN), chunk, Buffer.from(RESET)]);
  }
  return chunk;
}

function patch(stream: NodeJS.WriteStream): void {
  if (!shouldColor(stream)) return;
  const original = stream.write.bind(stream);
  // Match the (chunk, encoding?, cb?) overload without redeclaring the union.
  stream.write = ((chunk: unknown, ...rest: unknown[]) => {
    return (original as (...a: unknown[]) => boolean)(paint(chunk), ...rest);
  }) as typeof stream.write;
}

patch(process.stdout);
patch(process.stderr);
