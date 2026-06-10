// `modulus models` - list Ollama / enabled module models and pick chat /
// reasoning / tools profiles.
//
// Distinct from `modulus init` in that it only touches the model fields and
// never prompts for Telegram / tier / etc. Useful when the user adds or
// removes models in Ollama and wants to repoint Modulus without rewriting
// everything else.

import { input, select } from '@inquirer/prompts';
import { effectiveConfig, homeDir, loadConfig, saveConfig } from './config-store.js';
import { probeOllama } from './ollama-probe.js';
import { availableModelTags } from './model-options.js';

export async function run(): Promise<void> {
  const home = homeDir();
  const cfg = loadConfig(home);
  const effective = effectiveConfig(home);

  process.stdout.write(`Probing Ollama at ${effective.ollama.url}...\n`);
  const probe = await probeOllama(effective.ollama.url);
  const choices = availableModelTags(probe.ok ? probe.models : [], home);
  if (!probe.ok && choices.length === 0) {
    process.stderr.write(`x Ollama unreachable: ${probe.error ?? 'unknown error'}\n`);
    process.exit(1);
  }
  if (probe.ok && choices.length === 0) {
    process.stderr.write(
      'x Ollama is up but reports zero models. `ollama pull qwen3.5:0.8b` (or `ollama pull gemma3:4b`) first.\n',
    );
    process.exit(1);
  }
  if (probe.ok) {
    process.stdout.write(`ok ${probe.models.length} Ollama models found.\n\n`);
  } else {
    process.stdout.write(
      `x Ollama unreachable (${probe.error ?? 'unknown error'}); showing enabled module models.\n\n`,
    );
  }

  const chatPick = await select({
    message: 'Chat profile model:',
    choices: [
      ...choices.map((m) => ({ name: m, value: m })),
      { name: '(enter a model name manually)', value: '__custom__' },
    ],
    default: choices.includes(cfg.models.chat) ? cfg.models.chat : choices[0],
  });
  cfg.models.chat =
    chatPick === '__custom__'
      ? await input({ message: 'Chat model tag:', default: cfg.models.chat })
      : chatPick;

  const reasonPick = await select({
    message: 'Reasoning profile model:',
    choices: [
      { name: '(skip - small device)', value: '__skip__' },
      ...choices.map((m) => ({ name: m, value: m })),
      { name: '(enter a model name manually)', value: '__custom__' },
    ],
    default: cfg.models.reason ?? '__skip__',
  });
  if (reasonPick === '__skip__') {
    delete cfg.models.reason;
  } else if (reasonPick === '__custom__') {
    cfg.models.reason = await input({ message: 'Reasoning model tag:' });
  } else {
    cfg.models.reason = reasonPick;
  }

  const toolsPick = await select({
    message: 'Tool-use profile model (handles every tool-bearing turn):',
    choices: [
      { name: '(skip - reuse chat model for tool turns)', value: '__skip__' },
      ...choices.map((m) => ({ name: m, value: m })),
      { name: '(enter a model name manually)', value: '__custom__' },
    ],
    default: cfg.models.tools ?? '__skip__',
  });
  if (toolsPick === '__skip__') {
    delete cfg.models.tools;
  } else if (toolsPick === '__custom__') {
    cfg.models.tools = await input({ message: 'Tool-use model tag:' });
  } else {
    cfg.models.tools = toolsPick;
  }

  saveConfig(cfg, home);
  process.stdout.write('ok Updated chat/reason/tools models.\n');
}
