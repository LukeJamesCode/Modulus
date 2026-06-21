using System.IO;
using Microsoft.UI.Dispatching;
using Microsoft.UI.Xaml;
using Microsoft.Windows.AppLifecycle;

namespace ModulusDesktop;

public partial class App : Application
{
    private MainWindow? _window;
    private TrayController? _tray;
    private DaemonManager? _daemon;
    private UpdateChecker? _updates;
    private FileSystemWatcher? _applyWatcher;
    private DispatcherQueue? _dispatcher;
    private bool _quitting;

    public bool IsQuitting => _quitting;

    public App()
    {
        InitializeComponent();
        UnhandledException += (_, e) =>
        {
            DaemonLog.Write($"unhandled: {e.Exception}");
        };
    }

    protected override void OnLaunched(LaunchActivatedEventArgs args)
    {
        _dispatcher = DispatcherQueue.GetForCurrentThread();

        var paths = AppPaths.Resolve();
        _daemon = new DaemonManager(paths);
        _updates = new UpdateChecker();
        _window = new MainWindow(this, _daemon);
        _tray = new TrayController(this, _daemon, _window, paths, _updates);
        SetupApplyUpdateWatcher();

        // Second-launch redirection: focus/show the window.
        AppInstance.GetCurrent().Activated += (_, _) =>
            _dispatcher?.TryEnqueue(() => _window?.ShowAndFocus());

        var hidden = Environment.GetCommandLineArgs().Contains("--hidden");
        if (!hidden) _window.ShowAndFocus();

        // First run (no desktop.json) → show the local-vs-remote chooser and let
        // it start the daemon once the user picks. A saved choice starts straight
        // away: remote connects to the configured backend; anything else is local.
        var cfg = DesktopConfig.Load();
        if (cfg is null)
        {
            _window.ShowChooser();
        }
        else if (cfg.Mode == "remote" &&
                 !string.IsNullOrEmpty(cfg.RemoteUrl) &&
                 Uri.TryCreate(cfg.RemoteUrl, UriKind.Absolute, out var remoteUrl))
        {
            _daemon.ConfigureRemote(remoteUrl, cfg.RemoteToken ?? PanelLocator.TokenFromUrl(remoteUrl) ?? "");
            _ = _daemon.StartAsync();
        }
        else
        {
            _daemon.ConfigureLocal();
            _ = _daemon.StartAsync();
        }
    }

    // Watch ~/.modulus for the apply-update sentinel the panel's "Restart to
    // apply" button drops (POST /api/maintenance/desktop-update/apply). When it
    // appears, apply the already-downloaded update and relaunch. Only acts when an
    // update is actually staged — otherwise RestartToUpdate would quit without
    // relaunching. Name must match DESKTOP_APPLY_UPDATE_FILE in system.ts.
    private void SetupApplyUpdateWatcher()
    {
        try
        {
            var home = AppPaths.ModulusHome;
            Directory.CreateDirectory(home);
            _applyWatcher = new FileSystemWatcher(home, "desktop-apply-update")
            {
                NotifyFilter = NotifyFilters.FileName | NotifyFilters.LastWrite,
                EnableRaisingEvents = true,
            };
            void OnApply(object _, FileSystemEventArgs e)
            {
                try { File.Delete(e.FullPath); } catch { /* best effort */ }
                if (_updates?.HasUpdate == true)
                    _dispatcher?.TryEnqueue(RestartToUpdate);
                else
                    DaemonLog.Write("apply-update requested but no update is staged");
            }
            _applyWatcher.Created += OnApply;
            _applyWatcher.Changed += OnApply;
        }
        catch (Exception e)
        {
            DaemonLog.Write($"apply-update watcher setup failed: {e.Message}");
        }
    }

    public void ShowMainWindow() => _dispatcher?.TryEnqueue(() => _window?.ShowAndFocus());

    public async void Quit()
    {
        if (_quitting) return;
        _quitting = true;
        try
        {
            _tray?.Dispose();
            if (_daemon is not null) await _daemon.StopAsync();
        }
        catch (Exception e)
        {
            DaemonLog.Write($"quit cleanup failed: {e.Message}");
        }
        // A downloaded update installs after this process exits.
        _updates?.ApplyOnExit();
        Environment.Exit(0);
    }

    // Tray "Restart to update": same teardown as Quit, but the staged update
    // relaunches the app after it installs.
    public async void RestartToUpdate()
    {
        if (_quitting) return;
        _quitting = true;
        try
        {
            _tray?.Dispose();
            if (_daemon is not null) await _daemon.StopAsync();
        }
        catch (Exception e)
        {
            DaemonLog.Write($"update restart cleanup failed: {e.Message}");
        }
        _updates?.ApplyAndRestart();
        Environment.Exit(0);
    }
}
