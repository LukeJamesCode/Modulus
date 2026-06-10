// Voice Hub — the speech-first counterpart to Chat Hub. Shown in the sidebar
// only when modulus-voice is enabled. Wires the existing pieces together:
//   mic → POST /api/chat/voice-in       (whisper.cpp transcription)
//   text → POST /api/chat (SSE stream)  (orchestrator reply + `voice` event)
//   <audio src=/api/chat/voice/:id>     (Piper TTS clip, autoplay)
//
// Entering the hub turns modulus-voice on for this chat (otherwise the chat
// stream produces no `voice` events). The user can still flip /voice off from
// Chat Hub or Telegram.
const { useState: useVS, useEffect: useVE, useRef: useVR, useCallback: useVC } = React;

const VOICE_LOG_KEY = 'modulus_chat_messages'; // shared with Chat Hub
const VOICE_LOG_MAX = 200;

function loadHistoryAsTurns() {
  try {
    const raw = localStorage.getItem(VOICE_LOG_KEY);
    if (!raw) return [];
    const msgs = JSON.parse(raw);
    if (!Array.isArray(msgs)) return [];
    const turns = [];
    let i = 0;
    while (i < msgs.length) {
      const m = msgs[i];
      if (m.role === 'user') {
        const turn = {
          id: m.id ?? Date.now() + Math.random(),
          user: m.text,
          assistant: '',
          audioUrl: null,
        };
        i++;
        const parts = [];
        while (i < msgs.length && msgs[i].role === 'assistant') {
          parts.push(msgs[i].text);
          i++;
        }
        if (parts.length) turn.assistant = parts.join('\n');
        turns.push(turn);
      } else {
        i++;
      }
    }
    return turns;
  } catch {
    return [];
  }
}

function appendTurnToStorage(userText, assistantText) {
  try {
    const raw = localStorage.getItem(VOICE_LOG_KEY);
    const arr = raw ? (JSON.parse(raw) ?? []) : [];
    const msgs = Array.isArray(arr) ? arr : [];
    const t = new Date().toTimeString().slice(0, 5);
    msgs.push({ id: Date.now(), role: 'user', text: userText, time: t });
    msgs.push({ id: Date.now() + 0.5, role: 'assistant', text: assistantText, time: t });
    const trimmed = msgs.length > VOICE_LOG_MAX ? msgs.slice(-VOICE_LOG_MAX) : msgs;
    localStorage.setItem(VOICE_LOG_KEY, JSON.stringify(trimmed));
  } catch {
    /* quota — silently drop */
  }
}

function VoiceHub({ agent, onStart, onStop, health, activeModel, onLeave }) {
  const running = agent === 'running';
  // idle | listening | thinking | speaking
  const [phase, setPhase] = useVS('idle');
  const [turns, setTurns] = useVS(loadHistoryAsTurns); // { id, user, assistant, audioUrl }
  const [partial, setPartial] = useVS(''); // streaming assistant text
  const [error, setError] = useVS(null);
  const [continuous, setContinuous] = useVS(false);
  const [voiceReady, setVoiceReady] = useVS(false);

  const recorderRef = useVR(null);
  const chunksRef = useVR([]);
  const startedRef = useVR(0);
  const streamRef = useVR(null);
  const audioRef = useVR(null);
  const continuousRef = useVR(false);
  // VAD state — kept in refs so the rAF loop sees the latest values without
  // forcing a re-render every audio frame.
  const vadCtxRef = useVR(null);
  const vadRafRef = useVR(0);
  const [vadLevel, setVadLevel] = useVS(0); // 0..1 indicator for the orb glow
  useVE(() => {
    continuousRef.current = continuous;
  }, [continuous]);

  const supported =
    typeof MediaRecorder !== 'undefined' &&
    navigator.mediaDevices &&
    navigator.mediaDevices.getUserMedia;

  // Turn TTS on for this chat when entering the hub so the chat stream emits
  // the `voice` event we autoplay below. We do this once per mount; the user
  // can still /voice off elsewhere.
  useVE(() => {
    let cancelled = false;
    (async () => {
      const r = await window.api.post('/api/command', { name: 'voice', args: 'on' });
      if (!cancelled) setVoiceReady(!!(r && r.ok));
    })();
    return () => {
      cancelled = true;
      if (streamRef.current) streamRef.current.abort();
      if (recorderRef.current && recorderRef.current.state !== 'inactive') {
        try {
          recorderRef.current.stop();
        } catch {
          /* ignore */
        }
      }
      if (audioRef.current) {
        try {
          audioRef.current.pause();
        } catch {
          /* ignore */
        }
      }
      teardownVad();
    };
  }, []);

  // Auto-stop tunables. Match the feel of phone voice assistants: ~1.4s of
  // silence after speech ends the turn, with a hard cap so a stuck mic can't
  // record forever, and a minimum window so a tap-and-immediately-speak still
  // registers even before the user has uttered the first syllable.
  const VAD_SPEECH_RMS = 0.02;
  const VAD_SILENCE_MS = 1400;
  const VAD_MIN_MS = 600;
  const VAD_MAX_MS = 30_000;

  const teardownVad = () => {
    if (vadRafRef.current) {
      cancelAnimationFrame(vadRafRef.current);
      vadRafRef.current = 0;
    }
    if (vadCtxRef.current) {
      try {
        vadCtxRef.current.close();
      } catch {
        /* ignore */
      }
      vadCtxRef.current = null;
    }
    setVadLevel(0);
  };

  // After Modulus finishes speaking, optionally re-arm the mic for a back-and-
  // forth conversation. Guarded so we don't start while the agent is down.
  const startListening = useVC(async () => {
    if (!supported || !running || phase !== 'idle') return;
    setError(null);
    try {
      const media = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mime = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
        ? 'audio/webm;codecs=opus'
        : MediaRecorder.isTypeSupported('audio/ogg;codecs=opus')
          ? 'audio/ogg;codecs=opus'
          : '';
      const rec = mime ? new MediaRecorder(media, { mimeType: mime }) : new MediaRecorder(media);
      chunksRef.current = [];
      startedRef.current = Date.now();
      rec.ondataavailable = (e) => {
        if (e.data && e.data.size) chunksRef.current.push(e.data);
      };
      rec.onstop = async () => {
        teardownVad();
        media.getTracks().forEach((t) => t.stop());
        const ms = Date.now() - startedRef.current;
        const blob = new Blob(chunksRef.current, { type: rec.mimeType || 'audio/webm' });
        if (blob.size === 0) {
          setError("Didn't catch any audio. Check your mic permission and try again.");
          setPhase('idle');
          return;
        }
        setPhase('thinking');
        const r = await window.api.postBlob(
          '/api/chat/voice-in?ms=' + ms,
          blob,
          rec.mimeType || 'audio/webm',
        );
        if (!r.ok || !r.data || !r.data.ok || !r.data.transcript) {
          setError((r.data && r.data.error) || r.error || 'Could not transcribe.');
          setPhase('idle');
          return;
        }
        send(r.data.transcript.trim());
      };
      // MediaRecorder + a parallel AnalyserNode on the same MediaStream gives
      // us voice-activity detection: we sample audio level continuously and
      // stop the recorder once the user goes quiet after having spoken. This
      // means a single tap → speak → done, no second tap required.
      const Ctx = window.AudioContext || window.webkitAudioContext;
      const audioCtx = new Ctx();
      vadCtxRef.current = audioCtx;
      const source = audioCtx.createMediaStreamSource(media);
      const analyser = audioCtx.createAnalyser();
      analyser.fftSize = 1024;
      source.connect(analyser);
      const buf = new Float32Array(analyser.fftSize);
      let heardSpeech = false;
      let lastSpeechAt = Date.now();
      const tick = () => {
        if (!vadCtxRef.current || rec.state === 'inactive') return;
        analyser.getFloatTimeDomainData(buf);
        let sum = 0;
        for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
        const rms = Math.sqrt(sum / buf.length);
        setVadLevel(Math.min(1, rms * 8));
        const now = Date.now();
        if (rms > VAD_SPEECH_RMS) {
          heardSpeech = true;
          lastSpeechAt = now;
        }
        const elapsed = now - startedRef.current;
        const silenceFor = now - lastSpeechAt;
        const shouldStop =
          elapsed > VAD_MAX_MS ||
          (heardSpeech && elapsed > VAD_MIN_MS && silenceFor > VAD_SILENCE_MS);
        if (shouldStop) {
          stopListening();
          return;
        }
        vadRafRef.current = requestAnimationFrame(tick);
      };
      rec.start();
      recorderRef.current = rec;
      setPhase('listening');
      vadRafRef.current = requestAnimationFrame(tick);
    } catch {
      teardownVad();
      setError('Microphone access was denied or unavailable.');
      setPhase('idle');
    }
    // send is defined below; React closure captures the latest via ref-less call
    // (we only ever read it inside async event handlers, not during this scope).
  }, [running, phase, supported]);

  const stopListening = () => {
    const rec = recorderRef.current;
    if (rec && rec.state !== 'inactive') rec.stop();
  };

  const send = (text) => {
    if (!text) {
      setPhase('idle');
      return;
    }
    const id = Date.now() + Math.random();
    setTurns((t) => [...t, { id, user: text, assistant: '', audioUrl: null }]);
    setPartial('');
    setPhase('thinking');
    let acc = '';
    let gotVoice = false;
    streamRef.current = window.api.postStream(
      '/api/chat',
      { text },
      {
        onEvent: (ev, data) => {
          if (ev === 'delta' && data && data.delta) {
            acc += data.delta;
            setPartial(acc);
          } else if (ev === 'replace' && data && typeof data.text === 'string') {
            acc = data.text;
            setPartial(acc);
          } else if (ev === 'instant' && data && typeof data.text === 'string') {
            acc = (acc ? acc + '\n' : '') + data.text;
            setPartial(acc);
          } else if (ev === 'voice' && data && data.id) {
            gotVoice = true;
            const url = window.api.url('/api/chat/voice/' + data.id);
            setTurns((tt) => tt.map((row) => (row.id === id ? { ...row, audioUrl: url } : row)));
            playAudio(url);
          } else if (ev === 'done') {
            const finalText = (data && data.text) || acc;
            setTurns((tt) =>
              tt.map((row) => (row.id === id ? { ...row, assistant: finalText } : row)),
            );
            setPartial('');
            if (finalText) appendTurnToStorage(text, finalText);
            if (!gotVoice) {
              // No TTS clip is coming (module off / synth failed) — just
              // settle and re-arm if continuous is on.
              settleAfterReply();
            }
          } else if (ev === 'error') {
            setError((data && data.message) || 'The model could not be reached.');
            setPartial('');
            setPhase('idle');
            streamRef.current = null;
          }
        },
      },
    );
    streamRef.current.done
      .catch(() => {})
      .finally(() => {
        streamRef.current = null;
      });
  };

  const playAudio = (url) => {
    setPhase('speaking');
    const a = new Audio(url);
    audioRef.current = a;
    a.onended = settleAfterReply;
    a.onerror = settleAfterReply;
    a.play().catch(() => settleAfterReply());
  };

  const settleAfterReply = () => {
    audioRef.current = null;
    setPhase('idle');
    if (continuousRef.current && running) {
      // Tiny delay so the UI repaints "idle" first and the mic doesn't pick up
      // the tail of TTS bleeding through the speaker.
      setTimeout(() => startListening(), 350);
    }
  };

  const toggleMic = () => {
    if (phase === 'listening') stopListening();
    else if (phase === 'speaking') {
      if (audioRef.current) {
        try {
          audioRef.current.pause();
        } catch {
          /* ignore */
        }
      }
      settleAfterReply();
    } else if (phase === 'idle') startListening();
  };

  const cancelTurn = () => {
    if (streamRef.current) streamRef.current.abort();
    streamRef.current = null;
    if (audioRef.current) {
      try {
        audioRef.current.pause();
      } catch {
        /* ignore */
      }
      audioRef.current = null;
    }
    setPartial('');
    setPhase('idle');
  };

  const clearTurns = () => {
    cancelTurn();
    setTurns([]);
    try {
      localStorage.removeItem(VOICE_LOG_KEY);
    } catch {
      /* ignore */
    }
    window.api.post('/api/chat/clear');
  };

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        minHeight: 0,
        overflow: 'hidden',
      }}
    >
      <VoiceHeader
        agent={agent}
        onStart={onStart}
        onStop={onStop}
        onLeave={onLeave}
        onClear={clearTurns}
        continuous={continuous}
        onContinuous={setContinuous}
        voiceReady={voiceReady}
        activeModel={activeModel}
        health={health}
      />

      <div
        style={{
          flex: 1,
          minHeight: 0,
          marginTop: 12,
          display: 'flex',
          gap: 12,
          flexWrap: 'nowrap',
          alignItems: 'stretch',
          overflow: 'hidden',
        }}
      >
        <div
          style={{
            flex: '1 1 0',
            minWidth: 320,
            minHeight: 0,
            overflow: 'hidden',
            background: 'var(--surface)',
            border: '1px solid var(--border)',
            borderRadius: 'var(--radius)',
            boxShadow: 'var(--shadow-sm)',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            padding: 32,
            gap: 22,
          }}
        >
          <MicOrb
            phase={phase}
            disabled={!supported || !running}
            onClick={toggleMic}
            level={vadLevel}
          />
          <StatusLine
            phase={phase}
            running={running}
            supported={!!supported}
            voiceReady={voiceReady}
          />
          {phase === 'thinking' && partial && (
            <p
              style={{
                maxWidth: 520,
                fontSize: 14,
                color: 'var(--text-2)',
                lineHeight: 1.5,
                whiteSpace: 'pre-wrap',
                textAlign: 'center',
              }}
            >
              {partial}
            </p>
          )}
          {error && (
            <div
              role="alert"
              style={{
                maxWidth: 460,
                background: 'color-mix(in oklab, var(--err) 12%, var(--surface-2))',
                border: '1px solid color-mix(in oklab, var(--err) 45%, var(--border))',
                color: 'var(--err)',
                borderRadius: 'var(--radius-sm)',
                padding: '10px 14px',
                fontSize: 13.5,
                display: 'flex',
                alignItems: 'flex-start',
                gap: 9,
              }}
            >
              <window.Icon name="alert" size={16} style={{ flex: 'none', marginTop: 1 }} />
              <span style={{ flex: 1, lineHeight: 1.45 }}>{error}</span>
              <button
                onClick={() => setError(null)}
                title="Dismiss"
                style={{
                  background: 'none',
                  border: 'none',
                  color: 'var(--err)',
                  cursor: 'pointer',
                  padding: 0,
                  flex: 'none',
                }}
              >
                <window.Icon name="x" size={14} />
              </button>
            </div>
          )}
          {(phase === 'thinking' || phase === 'speaking') && (
            <window.Button variant="subtle" icon="stop" size="sm" onClick={cancelTurn}>
              Stop
            </window.Button>
          )}
        </div>

        <TurnsPanel turns={turns} partial={partial} phase={phase} />
      </div>
    </div>
  );
}

function VoiceHeader({
  agent,
  onStart,
  onStop,
  onLeave,
  onClear,
  continuous,
  onContinuous,
  voiceReady,
  activeModel,
  health,
}) {
  const running = agent === 'running';
  return (
    <div
      style={{
        background: 'var(--surface)',
        border: '1px solid var(--border)',
        borderRadius: 'var(--radius)',
        boxShadow: 'var(--shadow-sm)',
        padding: 14,
        display: 'flex',
        alignItems: 'center',
        gap: 14,
        flexWrap: 'wrap',
      }}
    >
      <span
        style={{
          width: 42,
          height: 42,
          borderRadius: 12,
          background: 'var(--accent-soft)',
          color: 'var(--accent-strong)',
          display: 'grid',
          placeItems: 'center',
          border: '1px solid var(--border)',
          flex: 'none',
        }}
      >
        <window.Icon name="mic" size={20} />
      </span>
      <div style={{ flex: 1, minWidth: 220 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
          <window.StatusDot state={running ? 'running' : 'stopped'} size={9} pulse={running} />
          <span style={{ fontWeight: 700, fontSize: 17 }}>Voice Hub</span>
          {!voiceReady && (
            <span style={{ fontSize: 12, color: 'var(--warn)', fontWeight: 600 }}>
              · waiting on modulus-voice
            </span>
          )}
        </div>
        <p style={{ color: 'var(--text-3)', fontSize: 13, marginTop: 3 }}>
          Talk to Modulus and hear the reply. Same model, tools and history as the chat hub
          {activeModel ? ` · ${activeModel}` : ''}.
          {!health.ollama && (
            <span style={{ color: 'var(--err)', marginLeft: 6 }}>· Ollama unreachable</span>
          )}
        </p>
      </div>

      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '6px 12px 6px 6px',
          borderRadius: 99,
          border: '1px solid var(--border)',
          background: 'var(--surface-2)',
        }}
        title="Automatically start listening again after Modulus finishes speaking."
      >
        <window.Toggle checked={continuous} onChange={onContinuous} label="Continuous mode" />
        <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-2)' }}>Continuous</span>
      </div>
      <window.Button variant="ghost" size="sm" icon="plus" onClick={onClear}>
        New chat
      </window.Button>
      <window.Button variant="subtle" size="sm" icon="chat" onClick={onLeave}>
        Chat hub
      </window.Button>
      <window.Button
        variant={running ? 'default' : 'primary'}
        size="sm"
        icon={running ? 'stop' : 'power'}
        onClick={running ? onStop : onStart}
        style={
          running
            ? {
                color: 'var(--err)',
                borderColor: 'color-mix(in oklab, var(--err) 40%, transparent)',
              }
            : {}
        }
      >
        {running ? 'Stop' : 'Start agent'}
      </window.Button>
    </div>
  );
}

function MicOrb({ phase, disabled, onClick, level = 0 }) {
  const pulsing = phase === 'listening' || phase === 'speaking';
  const colorVar =
    phase === 'listening'
      ? 'var(--err)'
      : phase === 'thinking'
        ? 'var(--warn)'
        : phase === 'speaking'
          ? 'var(--accent)'
          : 'var(--accent)';
  const ringSize = 200;
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={phase === 'listening' ? 'Stop listening' : 'Tap to speak'}
      style={{
        position: 'relative',
        width: ringSize,
        height: ringSize,
        borderRadius: '50%',
        border: 'none',
        cursor: disabled ? 'not-allowed' : 'pointer',
        background: 'transparent',
        padding: 0,
        opacity: disabled ? 0.5 : 1,
      }}
    >
      {pulsing && (
        <>
          <span
            style={{
              position: 'absolute',
              inset: 0,
              borderRadius: '50%',
              background: colorVar,
              opacity: 0.15,
              animation: 'voice-pulse 1.6s ease-out infinite',
            }}
          />
          <span
            style={{
              position: 'absolute',
              inset: 14,
              borderRadius: '50%',
              background: colorVar,
              opacity: 0.22,
              animation: 'voice-pulse 1.6s ease-out 0.4s infinite',
            }}
          />
        </>
      )}
      <span
        style={{
          position: 'absolute',
          inset: 30,
          borderRadius: '50%',
          background: colorVar,
          display: 'grid',
          placeItems: 'center',
          color: 'var(--on-accent)',
          boxShadow: '0 10px 40px color-mix(in oklab, ' + colorVar + ' 35%, transparent)',
          transition: 'background .2s, transform .08s',
          transform: phase === 'listening' ? `scale(${1 + level * 0.12})` : 'scale(1)',
        }}
      >
        <window.Icon
          name={phase === 'thinking' ? 'refresh' : phase === 'speaking' ? 'pulse' : 'mic'}
          size={56}
          className={phase === 'thinking' ? 'spin' : ''}
        />
      </span>
    </button>
  );
}

function StatusLine({ phase, running, supported, voiceReady }) {
  let msg = 'Tap the mic to speak';
  if (!supported) {
    // navigator.mediaDevices is only exposed on secure contexts. The most
    // common reason it's missing here is an http:// LAN URL — point at the
    // fix instead of just saying "unsupported".
    const insecureLan =
      typeof window !== 'undefined' &&
      !window.isSecureContext &&
      location.hostname !== 'localhost' &&
      location.hostname !== '127.0.0.1';
    msg = insecureLan
      ? 'The microphone needs HTTPS. Enable https_enabled in the modulus-frontend settings.'
      : 'This browser does not support audio recording.';
  } else if (!running) msg = 'Start the agent to begin a voice conversation.';
  else if (!voiceReady) msg = 'Setting up voice…';
  else if (phase === 'listening') msg = 'Listening — speak, then pause (or tap to send)';
  else if (phase === 'thinking') msg = 'Thinking…';
  else if (phase === 'speaking') msg = 'Modulus is speaking — tap to interrupt';
  return (
    <p style={{ fontSize: 15, fontWeight: 600, color: 'var(--text-2)', textAlign: 'center' }}>
      {msg}
    </p>
  );
}

function TurnsPanel({ turns, partial, phase }) {
  const scrollRef = useVR(null);
  useVE(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [turns, partial, phase]);
  return (
    <div
      style={{
        flex: '0 1 360px',
        width: '100%',
        minWidth: 0,
        minHeight: 0,
        alignSelf: 'stretch',
        maxWidth: 360,
        height: '100%',
        background: 'var(--surface)',
        border: '1px solid var(--border)',
        borderRadius: 'var(--radius)',
        boxShadow: 'var(--shadow-sm)',
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
      }}
    >
      <div
        style={{
          padding: '10px 14px',
          borderBottom: '1px solid var(--border)',
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          flex: 'none',
        }}
      >
        <window.Icon name="doc" size={15} style={{ color: 'var(--text-3)' }} />
        <span style={{ fontWeight: 600, fontSize: 14 }}>Transcript</span>
      </div>
      <div
        ref={scrollRef}
        style={{
          flex: 1,
          minHeight: 0,
          overflowY: 'auto',
          overflowX: 'hidden',
          padding: 14,
          display: 'flex',
          flexDirection: 'column',
          gap: 14,
        }}
      >
        {turns.length === 0 && (
          <p style={{ color: 'var(--text-3)', fontSize: 13, textAlign: 'center', marginTop: 16 }}>
            Your conversation will appear here.
          </p>
        )}
        {turns.map((t) => (
          <TurnRow key={t.id} turn={t} />
        ))}
        {phase === 'thinking' && partial && !turns.some((t) => t.assistant === partial) && (
          <div
            style={{
              fontSize: 13.5,
              color: 'var(--text-2)',
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
              overflowWrap: 'anywhere',
            }}
          >
            <span style={{ color: 'var(--text-3)', fontSize: 11.5, fontWeight: 600 }}>
              MODULUS (typing)
            </span>
            <div>{partial}</div>
          </div>
        )}
      </div>
    </div>
  );
}

function TurnRow({ turn }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <div>
        <span
          style={{
            color: 'var(--text-3)',
            fontSize: 11.5,
            fontWeight: 700,
            letterSpacing: 0.4,
          }}
        >
          YOU
        </span>
        <div
          style={{
            fontSize: 13.5,
            color: 'var(--text)',
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
            overflowWrap: 'anywhere',
          }}
        >
          {turn.user}
        </div>
      </div>
      {turn.assistant && (
        <div>
          <span
            style={{
              color: 'var(--text-3)',
              fontSize: 11.5,
              fontWeight: 700,
              letterSpacing: 0.4,
            }}
          >
            MODULUS
          </span>
          <div
            style={{
              fontSize: 13.5,
              color: 'var(--text-2)',
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
              overflowWrap: 'anywhere',
            }}
          >
            {turn.assistant}
          </div>
          {turn.audioUrl && (
            <audio
              controls
              src={turn.audioUrl}
              style={{ height: 32, marginTop: 4, width: '100%' }}
            />
          )}
        </div>
      )}
    </div>
  );
}

Object.assign(window, { VoiceHub });
