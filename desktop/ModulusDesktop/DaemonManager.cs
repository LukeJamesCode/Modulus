using System.Diagnostics;
using System.Text.Json;

namespace ModulusDesktop;

public enum DaemonStatus { Stopped, Starting, Running, Failed }

public sealed record DaemonSnapshot(
    DaemonStatus Status,
    Uri? PanelUrl,
    bool SetupMode,
    bool? OllamaOk,
    string? OllamaUrl,
    string? LastError);

// Owns the daemon child process and the /api/state poller. The daemon is
// controlled entirely over HTTP (POST /api/agent/stop) — win32 signals are
// hard kills, so they are only the last-resort fallback.
public sealed class DaemonManager : IDisposable
{
    private static readonly TimeSpan PollInterval = TimeSpan.FromSeconds(5);
    private static readonly int[] BackoffSeconds = [1, 5, 15, 60];

    private readonly AppPaths _paths;
    private readonly HttpClient _http = new() { Timeout = TimeSpan.FromSeconds(5) };
    private readonly object _gate = new();
    private readonly Queue<string> _recent = new();
    private readonly CancellationTokenSource _disposed = new();

    private Process? _child;
    private int? _adoptedPid;
    private Uri? _panelUrl;
    private string? _token;
    private DaemonStatus _status = DaemonStatus.Stopped;
    private bool _setupMode;
    private bool? _ollamaOk;
    private string? _ollamaUrl;
    private string? _lastError;
    private bool _stopRequested;
    private int _failures;
    private DateTime _lastFailureAt = DateTime.MinValue;
    private DateTime _runningSince = DateTime.MinValue;
    private int _adoptedProbeMisses;

    public event Action<DaemonSnapshot>? StateChanged;

    public DaemonManager(AppPaths paths)
    {
        _paths = paths;
        _ = PollLoopAsync();
    }

    public DaemonSnapshot Snapshot
    {
        get
        {
            lock (_gate)
            {
                return new DaemonSnapshot(_status, _panelUrl, _setupMode, _ollamaOk, _ollamaUrl, _lastError);
            }
        }
    }

    public string RecentOutput
    {
        get { lock (_gate) { return string.Join(Environment.NewLine, _recent); } }
    }

    public async Task StartAsync()
    {
        lock (_gate)
        {
            if (_status is DaemonStatus.Starting or DaemonStatus.Running) return;
            _stopRequested = false;
            _lastError = null;
        }
        SetStatus(DaemonStatus.Starting);

        if (await TryAdoptAsync()) return;

        try
        {
            Spawn();
        }
        catch (Exception e)
        {
            DaemonLog.Write($"spawn failed: {e.Message}");
            lock (_gate) { _lastError = $"Couldn't start the Modulus engine: {e.Message}"; }
            SetStatus(DaemonStatus.Failed);
            return;
        }

        await WaitForPanelAsync();
    }

    // An already-running daemon (started by the CLI, or re-exec'd by the
    // panel's own Restart button) is adopted rather than double-spawned; HTTP
    // control works the same without a child handle.
    private async Task<bool> TryAdoptAsync()
    {
        var pid = ReadPidFile();
        if (pid is null || !IsProcessAlive(pid.Value)) return false;

        var url = PanelLocator.FromFiles(AppPaths.ModulusHome);
        if (url is null) return false;
        var token = PanelLocator.TokenFromUrl(url);
        if (token is null) return false;

        if (await ProbeStateAsync(url, token) is null) return false;

        DaemonLog.Write($"adopted running daemon pid {pid}");
        lock (_gate)
        {
            _adoptedPid = pid;
            _child = null;
            _panelUrl = url;
            _token = token;
            _adoptedProbeMisses = 0;
            _runningSince = DateTime.UtcNow;
        }
        SetStatus(DaemonStatus.Running);
        return true;
    }

    private void Spawn()
    {
        var psi = new ProcessStartInfo
        {
            FileName = _paths.NodeExe,
            WorkingDirectory = _paths.AppRoot,
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
        };
        psi.ArgumentList.Add(_paths.CliEntry);
        psi.ArgumentList.Add("start");
        psi.ArgumentList.Add("--no-open");
        psi.Environment["MODULUS_DESKTOP"] = "1";
        if (_paths.Installed)
        {
            // Module enable shells out to npm; the bundled runtime dir carries
            // npm.cmd, so it must be resolvable on the child's PATH.
            var nodeDir = Path.GetDirectoryName(_paths.NodeExe)!;
            psi.Environment["PATH"] = nodeDir + ";" + (psi.Environment.TryGetValue("PATH", out var p) ? p : "");
        }

        var child = new Process { StartInfo = psi, EnableRaisingEvents = true };
        child.OutputDataReceived += (_, e) => OnLine(e.Data);
        child.ErrorDataReceived += (_, e) => OnLine(e.Data);
        child.Exited += (_, _) => OnExited(child);
        child.Start();
        child.BeginOutputReadLine();
        child.BeginErrorReadLine();

        lock (_gate)
        {
            _child = child;
            _adoptedPid = null;
        }
        DaemonLog.Write($"spawned daemon pid {child.Id} ({_paths.NodeExe} {_paths.CliEntry})");
    }

    private void OnLine(string? line)
    {
        if (line is null) return;
        lock (_gate)
        {
            _recent.Enqueue(line);
            while (_recent.Count > 200) _recent.Dequeue();
        }
        DaemonLog.Write($"[daemon] {line}");

        if (_panelUrl is null)
        {
            var url = PanelLocator.FromStdoutLine(line);
            if (url is not null)
            {
                lock (_gate)
                {
                    _panelUrl = url;
                    _token = PanelLocator.TokenFromUrl(url);
                }
            }
        }
    }

    private async Task WaitForPanelAsync()
    {
        var deadline = DateTime.UtcNow + TimeSpan.FromSeconds(90);
        while (DateTime.UtcNow < deadline && !_disposed.IsCancellationRequested)
        {
            Uri? url;
            string? token;
            lock (_gate)
            {
                if (_status != DaemonStatus.Starting) return; // crashed or stopped meanwhile
                url = _panelUrl;
                token = _token;
            }

            // After 10s without a stdout URL, fall back to token file + config.
            if (url is null && DateTime.UtcNow > deadline - TimeSpan.FromSeconds(80))
            {
                url = PanelLocator.FromFiles(AppPaths.ModulusHome);
                if (url is not null)
                {
                    token = PanelLocator.TokenFromUrl(url);
                    lock (_gate) { _panelUrl = url; _token = token; }
                }
            }

            if (url is not null && token is not null)
            {
                var state = await ProbeStateAsync(url, token);
                if (state is not null)
                {
                    ApplyState(state);
                    lock (_gate) { _runningSince = DateTime.UtcNow; }
                    SetStatus(DaemonStatus.Running);
                    return;
                }
            }

            try { await Task.Delay(1000, _disposed.Token); }
            catch (OperationCanceledException) { return; }
        }

        lock (_gate) { _lastError = "The Modulus engine started but its panel never came up."; }
        SetStatus(DaemonStatus.Failed);
    }

    private void OnExited(Process child)
    {
        int code;
        try { code = child.ExitCode; } catch { code = -1; }
        DaemonLog.Write($"daemon exited with code {code}");

        bool stopRequested;
        lock (_gate)
        {
            if (_child != child) return; // superseded by a newer spawn
            _child = null;
            _panelUrl = null;
            _token = null;
            stopRequested = _stopRequested;
        }

        if (stopRequested || _disposed.IsCancellationRequested)
        {
            SetStatus(DaemonStatus.Stopped);
            return;
        }

        _ = RecoverAsync();
    }

    // The panel's own Restart button re-execs a detached fresh daemon, so an
    // exit is not necessarily a crash: wait, then adopt if a live daemon holds
    // the pid file; only respawn (with backoff) when nothing is running.
    private async Task RecoverAsync()
    {
        try { await Task.Delay(2000, _disposed.Token); }
        catch (OperationCanceledException) { return; }

        SetStatus(DaemonStatus.Starting);
        if (await TryAdoptAsync()) return;

        lock (_gate)
        {
            var now = DateTime.UtcNow;
            // A long healthy stretch resets the crash counter.
            if (_runningSince != DateTime.MinValue && now - _runningSince > TimeSpan.FromMinutes(10))
                _failures = 0;
            if (_lastFailureAt != DateTime.MinValue && now - _lastFailureAt > TimeSpan.FromMinutes(2))
                _failures = 0;
            _failures++;
            _lastFailureAt = now;
        }

        int failures;
        lock (_gate) { failures = _failures; }
        if (failures > 5)
        {
            lock (_gate) { _lastError = "The Modulus engine keeps stopping unexpectedly."; }
            SetStatus(DaemonStatus.Failed);
            return;
        }

        var delay = TimeSpan.FromSeconds(BackoffSeconds[Math.Min(failures - 1, BackoffSeconds.Length - 1)]);
        DaemonLog.Write($"respawning daemon in {delay.TotalSeconds}s (failure {failures})");
        try { await Task.Delay(delay, _disposed.Token); }
        catch (OperationCanceledException) { return; }

        bool stopRequested;
        lock (_gate) { stopRequested = _stopRequested; }
        if (stopRequested) { SetStatus(DaemonStatus.Stopped); return; }

        try
        {
            Spawn();
        }
        catch (Exception e)
        {
            DaemonLog.Write($"respawn failed: {e.Message}");
            lock (_gate) { _lastError = $"Couldn't restart the Modulus engine: {e.Message}"; }
            SetStatus(DaemonStatus.Failed);
            return;
        }
        await WaitForPanelAsync();
    }

    public async Task StopAsync()
    {
        Uri? url;
        string? token;
        Process? child;
        int? adoptedPid;
        lock (_gate)
        {
            if (_status == DaemonStatus.Stopped) return;
            _stopRequested = true;
            url = _panelUrl;
            token = _token;
            child = _child;
            adoptedPid = _adoptedPid;
        }

        if (url is not null && token is not null)
        {
            try
            {
                using var req = new HttpRequestMessage(HttpMethod.Post,
                    new Uri(PanelLocator.Origin(url), "api/agent/stop"));
                req.Headers.Add("x-modulus-token", token);
                using var res = await _http.SendAsync(req);
                DaemonLog.Write($"stop request -> {(int)res.StatusCode}");
            }
            catch (Exception e)
            {
                DaemonLog.Write($"stop request failed: {e.Message}");
            }
        }

        // The daemon's own shutdown has an 8s hard-exit budget; give it 12.
        var exited = await WaitForDeathAsync(child, adoptedPid, TimeSpan.FromSeconds(12));
        if (!exited)
        {
            DaemonLog.Write("graceful stop timed out; killing process tree");
            try
            {
                if (child is not null) child.Kill(entireProcessTree: true);
                else if (adoptedPid is int pid) Process.GetProcessById(pid).Kill(entireProcessTree: true);
            }
            catch (Exception e)
            {
                DaemonLog.Write($"kill failed: {e.Message}");
            }
        }

        lock (_gate)
        {
            _child = null;
            _adoptedPid = null;
            _panelUrl = null;
            _token = null;
        }
        SetStatus(DaemonStatus.Stopped);
    }

    private static async Task<bool> WaitForDeathAsync(Process? child, int? adoptedPid, TimeSpan budget)
    {
        var deadline = DateTime.UtcNow + budget;
        while (DateTime.UtcNow < deadline)
        {
            if (child is not null)
            {
                if (child.HasExited) return true;
            }
            else if (adoptedPid is int pid)
            {
                if (!IsProcessAlive(pid)) return true;
            }
            else
            {
                return true;
            }
            await Task.Delay(250);
        }
        return false;
    }

    private async Task PollLoopAsync()
    {
        using var timer = new PeriodicTimer(PollInterval);
        try
        {
            while (await timer.WaitForNextTickAsync(_disposed.Token))
            {
                Uri? url;
                string? token;
                bool adopted;
                lock (_gate)
                {
                    if (_status != DaemonStatus.Running) continue;
                    url = _panelUrl;
                    token = _token;
                    adopted = _child is null && _adoptedPid is not null;
                }
                if (url is null || token is null) continue;

                var state = await ProbeStateAsync(url, token);
                if (state is not null)
                {
                    lock (_gate) { _adoptedProbeMisses = 0; }
                    ApplyState(state);
                    StateChanged?.Invoke(Snapshot);
                }
                else if (adopted)
                {
                    // No child handle to raise Exited — detect death by probe.
                    int misses;
                    lock (_gate) { misses = ++_adoptedProbeMisses; }
                    if (misses >= 3)
                    {
                        DaemonLog.Write("adopted daemon stopped responding");
                        lock (_gate) { _adoptedPid = null; _panelUrl = null; _token = null; }
                        SetStatus(DaemonStatus.Stopped);
                    }
                }
            }
        }
        catch (OperationCanceledException) { /* disposing */ }
    }

    private async Task<JsonDocument?> ProbeStateAsync(Uri url, string token)
    {
        try
        {
            using var req = new HttpRequestMessage(HttpMethod.Get,
                new Uri(PanelLocator.Origin(url), "api/state"));
            req.Headers.Add("x-modulus-token", token);
            using var res = await _http.SendAsync(req);
            if (!res.IsSuccessStatusCode) return null;
            var body = await res.Content.ReadAsStringAsync();
            return JsonDocument.Parse(body);
        }
        catch
        {
            return null;
        }
    }

    private void ApplyState(JsonDocument state)
    {
        using (state)
        {
            var root = state.RootElement;
            lock (_gate)
            {
                _setupMode = root.TryGetProperty("setupMode", out var s) && s.ValueKind == JsonValueKind.True;
                if (root.TryGetProperty("health", out var health) && health.ValueKind == JsonValueKind.Object)
                {
                    _ollamaOk = health.TryGetProperty("ollama", out var o)
                        ? o.ValueKind == JsonValueKind.True
                        : null;
                    _ollamaUrl = health.TryGetProperty("ollamaUrl", out var u) && u.ValueKind == JsonValueKind.String
                        ? u.GetString()
                        : null;
                }
                else
                {
                    _ollamaOk = null;
                }
            }
        }
    }

    private void SetStatus(DaemonStatus status)
    {
        lock (_gate) { _status = status; }
        StateChanged?.Invoke(Snapshot);
    }

    private static int? ReadPidFile()
    {
        try
        {
            var file = Path.Combine(AppPaths.ModulusHome, "modulus.pid");
            if (!File.Exists(file)) return null;
            var raw = File.ReadAllText(file).Trim();
            return int.TryParse(raw, out var pid) ? pid : null;
        }
        catch
        {
            return null;
        }
    }

    private static bool IsProcessAlive(int pid)
    {
        try
        {
            using var p = Process.GetProcessById(pid);
            return !p.HasExited;
        }
        catch
        {
            return false;
        }
    }

    public void Dispose()
    {
        _disposed.Cancel();
        _http.Dispose();
    }
}
