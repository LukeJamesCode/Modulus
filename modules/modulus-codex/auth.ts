// `modulus auth modulus-codex` — connect a ChatGPT subscription via OAuth.
//
// Two modes, chosen by the user up front:
//   • Local browser: we run the callback server on 127.0.0.1:1455 and capture
//     the redirect automatically.
//   • Headless (Pi over SSH): we print the URL, the user authorises on whatever
//     machine has a browser, then pastes the redirected URL (or the bare code)
//     back into the terminal. This is the common case for Modulus's target host.
//
// After the exchange we derive the ChatGPT account id from the id_token and run
// a one-shot probe against the Codex backend to catch the identity-only-scope
// trap (OpenClaw #29418) before the user's first real handoff fails.

import type { Host } from '../../src/core/modules.js';
import {
  CALLBACK_PORT,
  CALLBACK_PATH,
  buildAuthorizeUrl,
  createPkce,
  randomState,
  exchangeCode,
  extractAccountId,
  parsePastedRedirect,
  setupCallbackServer,
} from './lib/oauth.js';
import { probeAccess } from './lib/codex.js';
import { KEYS } from './lib/store.js';

const DEFAULT_BASE_URL = 'https://chatgpt.com/backend-api/codex';
const DEFAULT_MODEL = 'gpt-5.5';

function isYes(s: string): boolean {
  return /^(y|yes)$/i.test(s.trim());
}

export function register(host: Host): void {
  host.auth.flow({
    label: 'OpenAI Codex (ChatGPT subscription, OAuth 2.0 + PKCE)',
    run: async (io) => {
      io.print(
        'Connect Modulus to Codex using your ChatGPT Plus/Pro subscription.\n' +
          'No API key is needed — this reuses your existing ChatGPT plan.\n',
      );

      const pkce = createPkce();
      const state = randomState();
      const sameMachine = isYes(
        await io.prompt('Is a web browser available on THIS machine? (y/n):'),
      );

      let code: string;

      if (sameMachine) {
        // Local capture on the fixed Codex callback port.
        const redirectUri = `http://localhost:${CALLBACK_PORT}${CALLBACK_PATH}`;
        const server = setupCallbackServer('127.0.0.1', CALLBACK_PORT, state);
        let port: number;
        try {
          port = await server.actualPort;
        } catch (e) {
          server.close();
          throw new Error(
            `Could not bind ${redirectUri} (${e instanceof Error ? e.message : String(e)}). ` +
              'Re-run and answer "n" to use the paste-the-URL flow instead.',
          );
        }
        const authUrl = buildAuthorizeUrl({
          redirectUri: `http://localhost:${port}${CALLBACK_PATH}`,
          challenge: pkce.challenge,
          state,
        });
        io.print(`\nOpen this URL in your browser:\n\n  ${authUrl}\n`);
        io.print('Waiting for OpenAI to redirect back…');
        try {
          code = await server.code;
        } finally {
          server.close();
        }
      } else {
        // Headless: print URL, user pastes the result back.
        const redirectUri = `http://localhost:${CALLBACK_PORT}${CALLBACK_PATH}`;
        const authUrl = buildAuthorizeUrl({
          redirectUri,
          challenge: pkce.challenge,
          state,
        });
        io.print(
          '\nOn any device with a browser, open this URL and authorise:\n\n' +
            `  ${authUrl}\n\n` +
            'Your browser will try to load a "localhost" page that fails — that is expected.\n' +
            'Copy the FULL address bar URL from that failed page (it contains `code=…`).\n',
        );
        const pasted = await io.prompt('Paste the redirected URL (or just the code):');
        const parsed = parsePastedRedirect(pasted);
        if (!parsed) throw new Error('Could not find an authorization code in what you pasted.');
        if (parsed.state && parsed.state !== state) {
          throw new Error('OAuth state mismatch — the pasted URL does not match this session.');
        }
        code = parsed.code;
      }

      io.print('  Got authorization code, exchanging for tokens…');
      const redirectForExchange = `http://localhost:${CALLBACK_PORT}${CALLBACK_PATH}`;
      const tokens = await exchangeCode({
        code,
        verifier: pkce.verifier,
        redirectUri: redirectForExchange,
      });

      const accountId = extractAccountId(tokens.idToken);
      if (!accountId) {
        io.print(
          '  ⚠ Could not read a ChatGPT account id from the token. Codex calls may be rejected; ' +
            'if so, re-run auth or set codex_account_id via `modulus config modulus-codex`.',
        );
      }

      // Catch the identity-only-scope trap before the first real handoff.
      io.print('  Verifying the token can reach the Codex backend…');
      const probe = await probeAccess({
        baseUrl: DEFAULT_BASE_URL,
        accessToken: tokens.accessToken,
        accountId,
        model: DEFAULT_MODEL,
      });
      if (probe.ok) {
        io.print('  ✓ Codex backend reachable. Authorization complete.');
      } else {
        io.print(
          `  ⚠ Auth completed but the test call failed (${probe.status}): ${probe.detail}\n` +
            '    The token may lack Codex backend access, or the model/base_url may need adjusting.\n' +
            '    Credentials were still saved; fix with `modulus config modulus-codex` and try `/codex hello`.',
        );
      }

      const patch: Record<string, string | number | boolean> = {
        [KEYS.access]: tokens.accessToken,
        [KEYS.refresh]: tokens.refreshToken,
        [KEYS.expiresAt]: tokens.expiresAt,
      };
      if (tokens.idToken) patch[KEYS.id] = tokens.idToken;
      if (accountId) patch[KEYS.accountId] = accountId;
      return patch;
    },
  });

  void host;
}
