using System.Net;
using Microsoft.UI.Dispatching;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Media;
using Microsoft.Web.WebView2.Core;
using Launcher = Windows.System.Launcher;

namespace ModulusDesktop;

public sealed partial class MainWindow : Window
{
    private readonly App _app;
    private readonly DaemonManager _daemon;
    private readonly DispatcherQueue _dispatcher;
    private readonly DispatcherQueueTimer _retryTimer;
    private string? _splashTemplate;
    private Uri? _panelUrl;
    private bool _panelLoaded;
    private bool _webReady;

    public MainWindow(App app, DaemonManager daemon)
    {
        _app = app;
        _daemon = daemon;
        InitializeComponent();
        _dispatcher = DispatcherQueue.GetForCurrentThread();

        SystemBackdrop = new MicaBackdrop();
        AppWindow.Resize(new Windows.Graphics.SizeInt32(1280, 800));
        // Title-bar/taskbar icon; ApplicationIcon in the csproj only covers the
        // exe file itself.
        try { AppWindow.SetIcon(Path.Combine(AppContext.BaseDirectory, "Assets", "icon.ico")); }
        catch (Exception e) { DaemonLog.Write($"window icon failed: {e.Message}"); }
        AppWindow.Closing += (_, e) =>
        {
            if (!_app.IsQuitting)
            {
                e.Cancel = true;
                AppWindow.Hide();
            }
        };

        // Covers both transient load failures and the brief port drop when the
        // setup wizard promotes to the full daemon.
        _retryTimer = _dispatcher.CreateTimer();
        _retryTimer.Interval = TimeSpan.FromSeconds(2);
        _retryTimer.Tick += (_, _) =>
        {
            if (_panelUrl is not null && !_panelLoaded) Navigate(_panelUrl);
        };

        _daemon.StateChanged += snapshot => _dispatcher.TryEnqueue(() => OnDaemonState(snapshot));
        _ = InitWebViewAsync();
    }

    public void ShowAndFocus()
    {
        AppWindow.Show();
        Activate();
    }

    private async Task InitWebViewAsync()
    {
        // Unpackaged apps can't write a user-data folder next to the exe once
        // installed; keep the WebView2 profile under LocalAppData.
        var dataDir = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            "Modulus", "WebView2");
        Directory.CreateDirectory(dataDir);
        var env = await CoreWebView2Environment.CreateWithOptionsAsync(null, dataDir, null);
        await Web.EnsureCoreWebView2Async(env);
        _webReady = true;

        var core = Web.CoreWebView2;
        core.Settings.AreDefaultContextMenusEnabled = true;
        core.Settings.IsStatusBarEnabled = false;

        // Lockdown: only the local panel renders in-app; external links go to
        // the default browser; everything else is denied.
        core.NavigationStarting += (_, e) =>
        {
            if (e.Uri.StartsWith("about:", StringComparison.OrdinalIgnoreCase)) return;
            if (e.Uri.StartsWith("data:", StringComparison.OrdinalIgnoreCase)) return;
            if (_panelUrl is not null &&
                Uri.TryCreate(e.Uri, UriKind.Absolute, out var target) &&
                PanelLocator.Origin(target) == PanelLocator.Origin(_panelUrl))
            {
                return;
            }
            e.Cancel = true;
            if (Uri.TryCreate(e.Uri, UriKind.Absolute, out var external) &&
                (external.Scheme == "http" || external.Scheme == "https"))
            {
                LaunchExternal(external);
            }
        };
        core.NewWindowRequested += (_, e) =>
        {
            e.Handled = true;
            if (Uri.TryCreate(e.Uri, UriKind.Absolute, out var external) &&
                (external.Scheme == "http" || external.Scheme == "https"))
            {
                LaunchExternal(external);
            }
        };
        core.NavigationCompleted += (_, e) =>
        {
            var onPanel = _panelUrl is not null &&
                Uri.TryCreate(core.Source, UriKind.Absolute, out var current) &&
                PanelLocator.Origin(current) == PanelLocator.Origin(_panelUrl);
            if (onPanel && e.IsSuccess)
            {
                _panelLoaded = true;
                _retryTimer.Stop();
            }
            else if (onPanel && !e.IsSuccess)
            {
                _panelLoaded = false;
                ShowSplash("Reconnecting to Modulus…", null);
                _retryTimer.Start();
            }
        };

        OnDaemonState(_daemon.Snapshot);
    }

    private void OnDaemonState(DaemonSnapshot s)
    {
        if (!_webReady) return;
        switch (s.Status)
        {
            case DaemonStatus.Starting:
                if (!_panelLoaded) ShowSplash("Starting Modulus…", null);
                break;
            case DaemonStatus.Running when s.PanelUrl is not null:
                if (_panelUrl is null || PanelLocator.Origin(_panelUrl) != PanelLocator.Origin(s.PanelUrl) || !_panelLoaded)
                {
                    _panelUrl = s.PanelUrl;
                    Navigate(s.PanelUrl);
                    _retryTimer.Start();
                }
                break;
            case DaemonStatus.Failed:
                _panelLoaded = false;
                _retryTimer.Stop();
                ShowSplash(s.LastError ?? "Modulus couldn't start.", _daemon.RecentOutput);
                break;
            case DaemonStatus.Stopped:
                _panelLoaded = false;
                _retryTimer.Stop();
                ShowSplash("Modulus is stopped.", null);
                break;
        }
    }

    private static async void LaunchExternal(Uri url)
    {
        try { await Launcher.LaunchUriAsync(url); }
        catch (Exception e) { DaemonLog.Write($"external launch failed: {e.Message}"); }
    }

    private void Navigate(Uri url)
    {
        try
        {
            Web.Source = url;
        }
        catch (Exception e)
        {
            DaemonLog.Write($"navigate failed: {e.Message}");
        }
    }

    private void ShowSplash(string message, string? detail)
    {
        _splashTemplate ??= File.ReadAllText(
            Path.Combine(AppContext.BaseDirectory, "Assets", "splash.html"));
        var html = _splashTemplate
            .Replace("{{MESSAGE}}", WebUtility.HtmlEncode(message))
            .Replace("{{DETAIL}}", detail is null ? "" : WebUtility.HtmlEncode(detail))
            .Replace("{{DETAIL_DISPLAY}}", detail is null ? "none" : "block");
        Web.NavigateToString(html);
    }
}
