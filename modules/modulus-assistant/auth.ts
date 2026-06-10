import { randomBytes } from 'node:crypto';
import type { Host } from '../../src/core/modules.js';
import { setupOAuthCallbackServer } from '../../src/util/oauth-loopback.js';

// Combined scope: both Calendar and Tasks in one consent screen.
const SCOPE = 'https://www.googleapis.com/auth/calendar https://www.googleapis.com/auth/tasks';

// Fixed port used when listening for the nip.io callback so the user can
// pre-register the exact redirect URI in Google Cloud Console before the
// flow starts. Uses calendar's existing port 9004 so users who already
// registered that URI in GCC don't need to touch it.
const NIPIO_PORT = 9004;

export function setupCallbackServer(
  bindAddr: string,
  port: number,
  expectedState: string,
): { actualPort: Promise<number>; code: Promise<string> } {
  const { actualPort, code } = setupOAuthCallbackServer({
    bindAddr,
    port,
    expectedState,
    callbackPath: '/callback',
    completionMessage: 'Authorization complete. You can close this tab and return to the terminal.',
    noCodeError: 'no code returned by Google',
  });
  return { actualPort, code };
}

async function exchangeCode(
  clientId: string,
  clientSecret: string,
  code: string,
  redirectUri: string,
): Promise<string> {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      code,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
    }).toString(),
  });
  if (!res.ok) throw new Error(`Token exchange failed (${res.status})`);
  const j = (await res.json()) as { refresh_token?: string };
  if (!j.refresh_token) {
    throw new Error(
      'Google did not return a refresh_token. ' +
        'You may have already authorized this app — revoke access at ' +
        'https://myaccount.google.com/permissions and run `modulus auth` again.',
    );
  }
  return j.refresh_token;
}

export function register(host: Host): void {
  host.auth.flow({
    label: 'Google (Calendar + Tasks, OAuth 2.0)',
    run: async (io) => {
      io.print(
        'To authorize Modulus Everyday Assistant for Google Calendar and Tasks:\n' +
          '  1. Go to https://console.cloud.google.com/apis/credentials\n' +
          '  2. Enable both the Google Calendar API and the Google Tasks API on the project\n' +
          '  3. Create an OAuth 2.0 client — choose the right type for your setup:\n' +
          '\n' +
          '     Desktop app  — if you are running `modulus auth` on the same machine\n' +
          '                    as your browser. Google allows any http://127.0.0.1\n' +
          '                    port automatically; no redirect URI to register.\n' +
          '\n' +
          '     Web application — if Modulus runs on a home server / Pi that your\n' +
          '                    browser cannot reach via 127.0.0.1 (e.g. accessed\n' +
          '                    over SSH). Register\n' +
          '                    http://<your-ip>.nip.io:9004/callback in GCC and\n' +
          '                    enter your LAN IP when prompted below.\n' +
          '\n' +
          '  One OAuth client covers both Calendar and Tasks — no need for two.\n',
      );
      const client_id = await io.prompt('Client ID:');
      const client_secret = await io.prompt('Client secret:', { secret: true });

      io.print(
        '\nCallback address:\n' +
          '  Local machine (same machine as browser) → press Enter\n' +
          '  Home server / Pi                        → enter your LAN IP (e.g. 123.456.1.78)\n',
      );
      const lanIp = (await io.prompt('Server LAN IP (or Enter for localhost):')).trim();
      if (lanIp && !isValidIpv4(lanIp)) {
        throw new Error('Server LAN IP must be a plain IPv4 address, e.g. 192.168.1.42');
      }
      const usingNip = lanIp !== '';
      const callbackHost = usingNip ? `${lanIp}.nip.io` : '127.0.0.1';
      const bindAddr = usingNip ? '0.0.0.0' : '127.0.0.1';
      const listenPort = usingNip ? NIPIO_PORT : 0;

      if (usingNip) {
        io.print(
          `\nRedirect URI for this machine:\n` +
            `  http://${callbackHost}:${NIPIO_PORT}/callback\n` +
            `\nMake sure this is registered in your Google Cloud Console → OAuth client → Authorized redirect URIs.\n`,
        );
        await io.prompt('Press Enter once the redirect URI is registered…');
      }

      const state = randomBytes(16).toString('hex');
      const { actualPort: portP, code: codeP } = setupCallbackServer(bindAddr, listenPort, state);
      const port = await portP;
      const redirect_uri = `http://${callbackHost}:${port}/callback`;

      const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
      authUrl.searchParams.set('client_id', client_id);
      authUrl.searchParams.set('redirect_uri', redirect_uri);
      authUrl.searchParams.set('response_type', 'code');
      authUrl.searchParams.set('scope', SCOPE);
      authUrl.searchParams.set('access_type', 'offline');
      authUrl.searchParams.set('prompt', 'consent');
      authUrl.searchParams.set('state', state);

      io.print(`\nOpen this URL in your browser:\n\n  ${authUrl.toString()}\n`);
      io.print('Waiting for Google to redirect back…');

      const code = await codeP;
      io.print('  Got authorization code, exchanging for tokens…');

      const google_refresh_token = await exchangeCode(client_id, client_secret, code, redirect_uri);
      io.print('  ✓ Authorization complete. Both Calendar and Tasks are now authorized.');

      // Do NOT return default_tasklist — it has a working default in
      // helpers/tasks.ts and overwriting the user's `modulus config` choice on
      // re-auth is a footgun.
      return {
        google_client_id: client_id,
        google_client_secret: client_secret,
        google_refresh_token,
        calendar_id: 'primary',
      };
    },
  });
  void host;
}

export function isValidIpv4(input: string): boolean {
  const parts = input.split('.');
  if (parts.length !== 4) return false;
  return parts.every((part) => {
    if (!/^\d{1,3}$/.test(part)) return false;
    const n = Number(part);
    return n >= 0 && n <= 255 && String(n) === part;
  });
}
