using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using H.NotifyIcon;
using Microsoft.UI.Dispatching;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.Win32;

namespace ModulusDesktop;

// Tray icon + menu. Polls nothing itself — DaemonManager raises StateChanged
// from its own /api/state poller; the tray just renders the latest snapshot.
public sealed class TrayController : IDisposable
{
    private const string RunKeyPath = @"Software\Microsoft\Windows\CurrentVersion\Run";
    private const string RunKeyName = "Modulus";

    private readonly App _app;
    private readonly DaemonManager _daemon;
    private readonly MainWindow _window;
    private readonly DispatcherQueue _dispatcher;
    private readonly TaskbarIcon _tray;
    private readonly MenuFlyoutItem _startStopItem;
    private readonly MenuFlyoutItem _updateItem;
    private readonly ToggleMenuFlyoutItem _loginItem;
    private readonly Icon _iconOff;
    private readonly Icon _iconStarting;
    private readonly Icon _iconOk;
    private readonly Icon _iconWarn;
    private DaemonStatus _lastStatus = DaemonStatus.Stopped;

    public TrayController(App app, DaemonManager daemon, MainWindow window, AppPaths paths, UpdateChecker updates)
    {
        _app = app;
        _daemon = daemon;
        _window = window;
        _dispatcher = DispatcherQueue.GetForCurrentThread();

        _iconOff = MakeDotIcon(Color.FromArgb(107, 114, 128));      // gray
        _iconStarting = MakeDotIcon(Color.FromArgb(168, 85, 247));  // helix purple
        _iconOk = MakeDotIcon(Color.FromArgb(34, 197, 94));         // green
        _iconWarn = MakeDotIcon(Color.FromArgb(245, 158, 11));      // orange

        var menu = new MenuFlyout();

        var openItem = new MenuFlyoutItem { Text = "Open Panel" };
        openItem.Click += (_, _) => _window.ShowAndFocus();
        menu.Items.Add(openItem);

        _startStopItem = new MenuFlyoutItem { Text = "Stop Modulus" };
        _startStopItem.Click += (_, _) => ToggleDaemon();
        menu.Items.Add(_startStopItem);

        menu.Items.Add(new MenuFlyoutSeparator());

        _loginItem = new ToggleMenuFlyoutItem
        {
            Text = "Start at login",
            IsChecked = IsLoginEnabled(),
        };
        _loginItem.Click += (_, _) => SetLoginEnabled(_loginItem.IsChecked);
        menu.Items.Add(_loginItem);

        var logsItem = new MenuFlyoutItem { Text = "Open Logs" };
        logsItem.Click += (_, _) => OpenLogs();
        menu.Items.Add(logsItem);

        menu.Items.Add(new MenuFlyoutSeparator());

        // Hidden until UpdateChecker has a downloaded update pending.
        _updateItem = new MenuFlyoutItem { Text = "Restart to update", Visibility = Visibility.Collapsed };
        _updateItem.Click += (_, _) => _app.RestartToUpdate();
        menu.Items.Add(_updateItem);

        var quitItem = new MenuFlyoutItem { Text = "Quit Modulus" };
        quitItem.Click += (_, _) => _app.Quit();
        menu.Items.Add(quitItem);

        _tray = new TaskbarIcon
        {
            ToolTipText = "Modulus — starting…",
            Icon = _iconStarting,
            ContextMenuMode = ContextMenuMode.SecondWindow,
            ContextFlyout = menu,
            NoLeftClickDelay = true,
            LeftClickCommand = new RelayCommand(() => _window.ShowAndFocus()),
            DoubleClickCommand = new RelayCommand(() => _window.ShowAndFocus()),
        };
        _tray.ForceCreate();

        _daemon.StateChanged += s => _dispatcher.TryEnqueue(() => Render(s));
        updates.UpdateReady += () => _dispatcher.TryEnqueue(() => OnUpdateReady(updates));
        Render(_daemon.Snapshot);
    }

    private void OnUpdateReady(UpdateChecker updates)
    {
        _updateItem.Visibility = Visibility.Visible;
        ShowBalloon(
            "Modulus update ready",
            $"Version {updates.ReadyVersion} installs when you quit — or restart now from the tray menu.");
    }

    private void Render(DaemonSnapshot s)
    {
        // Balloon only on the transition into Failed (backoff gave up or the
        // panel never came up) — Render runs on every poll tick.
        if (s.Status == DaemonStatus.Failed && _lastStatus != DaemonStatus.Failed)
        {
            ShowBalloon(
                "Modulus stopped",
                s.LastError ?? "The Modulus engine stopped unexpectedly. Open the window for details.");
        }
        _lastStatus = s.Status;

        switch (s.Status)
        {
            case DaemonStatus.Stopped:
                _tray.Icon = _iconOff;
                _tray.ToolTipText = "Modulus — stopped";
                _startStopItem.Text = "Start Modulus";
                break;
            case DaemonStatus.Starting:
                _tray.Icon = _iconStarting;
                _tray.ToolTipText = "Modulus — starting…";
                _startStopItem.Text = "Stop Modulus";
                break;
            case DaemonStatus.Failed:
                _tray.Icon = _iconWarn;
                _tray.ToolTipText = "Modulus — failed to start (open the window for details)";
                _startStopItem.Text = "Start Modulus";
                break;
            case DaemonStatus.Running when s.SetupMode:
                _tray.Icon = _iconStarting;
                _tray.ToolTipText = "Modulus — finish setup in the app window";
                _startStopItem.Text = "Stop Modulus";
                break;
            case DaemonStatus.Running when s.OllamaOk == false:
                _tray.Icon = _iconWarn;
                _tray.ToolTipText = s.OllamaUrl is null
                    ? "Modulus — AI engine unreachable"
                    : $"Modulus — can't reach the AI engine at {s.OllamaUrl}";
                _startStopItem.Text = "Stop Modulus";
                break;
            case DaemonStatus.Running:
                _tray.Icon = _iconOk;
                _tray.ToolTipText = "Modulus — running";
                _startStopItem.Text = "Stop Modulus";
                break;
        }
    }

    private async void ToggleDaemon()
    {
        var status = _daemon.Snapshot.Status;
        if (status is DaemonStatus.Running or DaemonStatus.Starting)
        {
            await _daemon.StopAsync();
        }
        else
        {
            await _daemon.StartAsync();
        }
    }

    private static bool IsLoginEnabled()
    {
        using var key = Registry.CurrentUser.OpenSubKey(RunKeyPath);
        return key?.GetValue(RunKeyName) is not null;
    }

    private static void SetLoginEnabled(bool enabled)
    {
        using var key = Registry.CurrentUser.CreateSubKey(RunKeyPath);
        if (enabled)
        {
            var exe = Environment.ProcessPath ?? Process.GetCurrentProcess().MainModule!.FileName;
            key.SetValue(RunKeyName, $"\"{exe}\" --hidden");
        }
        else
        {
            key.DeleteValue(RunKeyName, throwOnMissingValue: false);
        }
    }

    private void ShowBalloon(string title, string message)
    {
        try
        {
            _tray.ShowNotification(title, message);
        }
        catch (Exception e)
        {
            DaemonLog.Write($"balloon failed: {e.Message}");
        }
    }

    private static void OpenLogs()
    {
        try
        {
            Directory.CreateDirectory(AppPaths.LogsDir);
            Process.Start(new ProcessStartInfo("explorer.exe", $"\"{AppPaths.LogsDir}\"") { UseShellExecute = true });
        }
        catch (Exception e)
        {
            DaemonLog.Write($"open logs failed: {e.Message}");
        }
    }

    // Simple filled-dot status icon drawn at runtime; no .ico assets needed.
    private static Icon MakeDotIcon(Color color)
    {
        using var bmp = new Bitmap(32, 32);
        using var g = Graphics.FromImage(bmp);
        g.SmoothingMode = SmoothingMode.AntiAlias;
        g.Clear(Color.Transparent);
        using var fill = new SolidBrush(color);
        g.FillEllipse(fill, 4, 4, 24, 24);
        return Icon.FromHandle(bmp.GetHicon());
    }

    public void Dispose()
    {
        _tray.Dispose();
    }
}
