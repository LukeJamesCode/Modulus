// Shared reader for the unified google_* OAuth settings. Calendar and Tasks
// both layer their service-specific field (calendar_id / default_tasklist) on
// top of the same client_id / client_secret / refresh_token triple.

import type { Host } from '../../../src/core/modules.js';
import type { GoogleOAuthCreds } from '../api/google-client.js';

export function readGoogleOAuth(host: Host): GoogleOAuthCreds | null {
  const s = host.settings;
  const id = s.get<string>('google_client_id');
  const secret = s.get<string>('google_client_secret');
  const refresh = s.get<string>('google_refresh_token');
  if (!id || !secret || !refresh) return null;
  return { client_id: id, client_secret: secret, refresh_token: refresh };
}
