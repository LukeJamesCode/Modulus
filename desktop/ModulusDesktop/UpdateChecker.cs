using System.IO;
using System.Text.Json;
using Velopack;
using Velopack.Sources;

namespace ModulusDesktop;

// Shell self-update via Velopack + GitHub Releases. Checks shortly after
// launch and then every few hours, downloads a newer release in the
// background, and applies it when the app exits (Quit) or immediately via the
// tray's "Restart to update". Dev runs are a no-op: only packed installs have
// the Velopack metadata UpdateManager needs.
public sealed class UpdateChecker : IDisposable
{
    private const string RepoUrl = "https://github.com/LukeJamesCode/Modulus";
    private static readonly TimeSpan InitialDelay = TimeSpan.FromMinutes(1);
    private static readonly TimeSpan CheckInterval = TimeSpan.FromHours(6);

    private readonly UpdateManager _manager;
    private readonly CancellationTokenSource _disposed = new();
    private UpdateInfo? _ready;

    // Raised (on a worker thread) once an update is downloaded and pending.
    public event Action? UpdateReady;

    public bool HasUpdate => _ready is not null;
    public string? ReadyVersion => _ready?.TargetFullRelease.Version.ToString();

    // Status file the daemon's panel reads to surface "update available" in the
    // web UI (see src/panel/routes/system.ts → readDesktopUpdateState). Name must
    // match DESKTOP_UPDATE_STATUS_FILE there.
    private static readonly string StatusFile =
        Path.Combine(AppPaths.ModulusHome, "desktop-update.json");

    public UpdateChecker()
    {
        _manager = new UpdateManager(new GithubSource(RepoUrl, accessToken: null, prerelease: false));
        if (_manager.IsInstalled)
        {
            // Clear any stale status from a previous run so the panel doesn't show
            // an "update available" that already installed.
            WriteStatus(false, null);
            _ = CheckLoopAsync();
        }
        else DaemonLog.Write("update checks disabled (not a packed install)");
    }

    // Mirror the downloaded-update state to the status file so the daemon's panel
    // can show it. Best-effort: a write failure just means the web UI won't show
    // the banner (the tray balloon + menu still do).
    private static void WriteStatus(bool hasUpdate, string? version)
    {
        try
        {
            Directory.CreateDirectory(AppPaths.ModulusHome);
            File.WriteAllText(StatusFile, JsonSerializer.Serialize(new { hasUpdate, version }));
        }
        catch (Exception e)
        {
            DaemonLog.Write($"update status write failed: {e.Message}");
        }
    }

    private async Task CheckLoopAsync()
    {
        try { await Task.Delay(InitialDelay, _disposed.Token); }
        catch (OperationCanceledException) { return; }

        while (!_disposed.IsCancellationRequested)
        {
            try
            {
                var info = await _manager.CheckForUpdatesAsync();
                if (info is not null)
                {
                    await _manager.DownloadUpdatesAsync(info);
                    _ready = info;
                    WriteStatus(true, ReadyVersion);
                    DaemonLog.Write($"update {ReadyVersion} downloaded; applies on next quit");
                    UpdateReady?.Invoke();
                    return; // one pending update is enough — it lands on exit
                }
            }
            catch (Exception e)
            {
                DaemonLog.Write($"update check failed: {e.Message}");
            }
            try { await Task.Delay(CheckInterval, _disposed.Token); }
            catch (OperationCanceledException) { return; }
        }
    }

    // Quit path, after the daemon is stopped: stage the downloaded update to
    // install once this process exits. Does not restart the app.
    public void ApplyOnExit()
    {
        if (_ready is null) return;
        try
        {
            _manager.WaitExitThenApplyUpdates(_ready, silent: true, restart: false);
        }
        catch (Exception e)
        {
            DaemonLog.Write($"apply-on-exit failed: {e.Message}");
        }
    }

    // Tray "Restart to update": stage the update and relaunch. The caller must
    // have stopped the daemon already; this exits the process.
    public void ApplyAndRestart()
    {
        if (_ready is null) return;
        try
        {
            _manager.WaitExitThenApplyUpdates(_ready, silent: true, restart: true);
        }
        catch (Exception e)
        {
            DaemonLog.Write($"apply-and-restart failed: {e.Message}");
        }
    }

    public void Dispose() => _disposed.Cancel();
}
