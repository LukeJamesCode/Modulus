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

        // Second-launch redirection: focus/show the window.
        AppInstance.GetCurrent().Activated += (_, _) =>
            _dispatcher?.TryEnqueue(() => _window?.ShowAndFocus());

        var hidden = Environment.GetCommandLineArgs().Contains("--hidden");
        if (!hidden) _window.ShowAndFocus();

        _ = _daemon.StartAsync();
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
