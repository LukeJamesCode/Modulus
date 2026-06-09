/* modulus-frontend API client.
 *
 * Thin wrapper around fetch that carries the panel token (read once from the
 * ?token= query param, then kept in localStorage) and exposes helpers for
 * JSON requests and Server-Sent Events. Every call resolves to { ok, data }
 * or { ok:false, error } so callers never have to try/catch network errors. */
(function () {
  const params = new URLSearchParams(location.search);
  const fromUrl = params.get('token');
  if (fromUrl) {
    try {
      // localStorage (not sessionStorage) so the token survives closing the
      // tab. The token is stripped from the URL below, so the entry saved in
      // browser history carries no token — without a persistent store,
      // reopening from history would 401.
      localStorage.setItem('modulus_token', fromUrl);
    } catch (e) {
      /* localStorage may be unavailable; header still set below */
    }
    // Strip the token from the visible URL bar without reloading.
    params.delete('token');
    const qs = params.toString();
    history.replaceState(null, '', location.pathname + (qs ? '?' + qs : ''));
  }
  let token = fromUrl || '';
  try {
    token = token || localStorage.getItem('modulus_token') || '';
  } catch (e) {
    /* ignore */
  }

  function headers(extra) {
    const h = Object.assign({}, extra || {});
    if (token) h['x-modulus-token'] = token;
    return h;
  }

  async function request(method, path, body) {
    try {
      const res = await fetch(path, {
        method,
        headers: headers(body ? { 'content-type': 'application/json' } : undefined),
        body: body ? JSON.stringify(body) : undefined,
      });
      const text = await res.text();
      let data = null;
      try {
        data = text ? JSON.parse(text) : null;
      } catch (e) {
        data = { raw: text };
      }
      if (!res.ok) {
        return {
          ok: false,
          status: res.status,
          error: (data && data.error) || res.statusText,
          data,
        };
      }
      return { ok: true, status: res.status, data };
    } catch (e) {
      return { ok: false, error: String(e && e.message ? e.message : e), offline: true };
    }
  }

  /* Stream Server-Sent Events. Returns an EventSource-like object with .close().
   * Used for log following and chat streaming. `onMessage` gets (eventName, data). */
  function streamSSE(path, { onMessage, onError, onOpen } = {}) {
    // EventSource can't send headers, so when a token is needed we fall back to
    // a query param. The server accepts ?token= for GET SSE routes.
    const url =
      token && path.indexOf('token=') === -1
        ? path + (path.indexOf('?') === -1 ? '?' : '&') + 'token=' + encodeURIComponent(token)
        : path;
    const es = new EventSource(url);
    if (onOpen) es.onopen = onOpen;
    es.onmessage = (e) => onMessage && onMessage('message', e.data);
    es.onerror = (e) => onError && onError(e);
    return es;
  }

  /* POST that streams an SSE response body (used for chat, which is a POST).
   * EventSource only does GET, so we parse the stream manually via fetch. */
  function postStream(path, body, { onEvent } = {}) {
    const controller = new AbortController();
    const promise = (async () => {
      try {
        const res = await fetch(path, {
          method: 'POST',
          headers: headers({ 'content-type': 'application/json' }),
          body: JSON.stringify(body),
          signal: controller.signal,
        });
        if (!res.ok || !res.body) {
          onEvent && onEvent('error', { message: 'HTTP ' + res.status });
          return;
        }
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buf = '';
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          let idx;
          while ((idx = buf.indexOf('\n\n')) !== -1) {
            const block = buf.slice(0, idx);
            buf = buf.slice(idx + 2);
            let ev = 'message';
            let dataStr = '';
            for (const line of block.split('\n')) {
              if (line.startsWith('event:')) ev = line.slice(6).trim();
              else if (line.startsWith('data:')) dataStr += line.slice(5).trim();
            }
            if (dataStr) {
              let parsed = dataStr;
              try {
                parsed = JSON.parse(dataStr);
              } catch (e) {
                /* keep string */
              }
              onEvent && onEvent(ev, parsed);
            }
          }
        }
      } catch (e) {
        if (controller.signal.aborted) return;
        onEvent && onEvent('error', { message: String(e && e.message ? e.message : e) });
      }
    })();
    return { abort: () => controller.abort(), done: promise };
  }

  /* POST a binary body (e.g. a recorded voice note). Resolves like request(). */
  async function postBlob(path, blob, contentType) {
    try {
      const h = headers();
      if (contentType) h['content-type'] = contentType;
      const res = await fetch(path, { method: 'POST', headers: h, body: blob });
      const text = await res.text();
      let data = null;
      try {
        data = text ? JSON.parse(text) : null;
      } catch (e) {
        data = { raw: text };
      }
      if (!res.ok) {
        return {
          ok: false,
          status: res.status,
          error: (data && data.error) || res.statusText,
          data,
        };
      }
      return { ok: true, status: res.status, data };
    } catch (e) {
      return { ok: false, error: String(e && e.message ? e.message : e), offline: true };
    }
  }

  /* POST a binary body with extra headers (e.g. staging an attachment, which
   * carries x-stage-token + x-filename). Resolves like request(). */
  async function postRaw(path, blob, extraHeaders) {
    try {
      const res = await fetch(path, {
        method: 'POST',
        headers: headers(extraHeaders || {}),
        body: blob,
      });
      const text = await res.text();
      let data = null;
      try {
        data = text ? JSON.parse(text) : null;
      } catch (e) {
        data = { raw: text };
      }
      if (!res.ok) {
        return {
          ok: false,
          status: res.status,
          error: (data && data.error) || res.statusText,
          data,
        };
      }
      return { ok: true, status: res.status, data };
    } catch (e) {
      return { ok: false, error: String(e && e.message ? e.message : e), offline: true };
    }
  }

  /* Build a tokenized URL for direct use in <audio src> / fetch (GET routes). */
  function url(path) {
    if (!token || path.indexOf('token=') !== -1) return path;
    return path + (path.indexOf('?') === -1 ? '?' : '&') + 'token=' + encodeURIComponent(token);
  }

  window.api = {
    get hasToken() {
      return !!token;
    },
    get: (path) => request('GET', path),
    post: (path, body) => request('POST', path, body),
    postBlob,
    postRaw,
    url,
    streamSSE,
    postStream,
  };
})();
