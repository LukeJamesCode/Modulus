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

        // Reclaim the title-bar strip and theme the caption buttons for the dark
        // backdrop, so there's no white bar across the top.
        ExtendsContentIntoTitleBar = true;
        SetTitleBar(AppTitleBar);
        var titleBar = AppWindow.TitleBar;
        titleBar.ButtonBackgroundColor = Microsoft.UI.Colors.Transparent;
        titleBar.ButtonInactiveBackgroundColor = Microsoft.UI.Colors.Transparent;
        titleBar.ButtonForegroundColor = Microsoft.UI.Colors.White;
        titleBar.ButtonInactiveForegroundColor = Windows.UI.Color.FromArgb(255, 0x6b, 0x6b, 0x73);
        titleBar.ButtonHoverBackgroundColor = Windows.UI.Color.FromArgb(255, 0x23, 0x23, 0x29);
        titleBar.ButtonHoverForegroundColor = Microsoft.UI.Colors.White;
        titleBar.ButtonPressedBackgroundColor = Windows.UI.Color.FromArgb(255, 0x1b, 0x1b, 0x1f);
        titleBar.ButtonPressedForegroundColor = Microsoft.UI.Colors.White;

        AppWindow.Resize(new Windows.Graphics.SizeInt32(1280, 800));
        // Title-bar/taskbar icon; ApplicationIcon in the csproj only covers the
        // exe file itself.
        try { AppWindow.SetIcon(Path.Combine(AppContext.BaseDirectory, "Assets", "icon.ico")); }
        catch (Exception e) { DaemonLog.Write($"window icon failed: {e.Message}"); }
        // Closing the window quits Modulus and stops the daemon. Cancel the
        // native close so the window can hide immediately for responsiveness,
        // then hand off to Quit, which stops the daemon, tears down the tray,
        // and exits the process.
        AppWindow.Closing += (_, e) =>
        {
            if (!_app.IsQuitting)
            {
                e.Cancel = true;
                AppWindow.Hide();
                _app.Quit();
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

    // First-run, or the tray's "Connection…" item. Prefills the remote box from
    // the saved config so switching back and forth is easy.
    public void ShowChooser()
    {
        _dispatcher.TryEnqueue(() =>
        {
            RemoteError.Visibility = Visibility.Collapsed;
            var cfg = DesktopConfig.Load();
            RemoteUrlBox.Text = cfg?.Mode == "remote" ? cfg.RemoteUrl ?? "" : "";
            SetupOverlay.Visibility = Visibility.Visible;
            ShowAndFocus();
        });
    }

    private async void OnChooseLocal(object sender, RoutedEventArgs e)
    {
        DesktopConfig.Save(new DesktopConfig { Mode = "local" });
        _daemon.ConfigureLocal();
        SetupOverlay.Visibility = Visibility.Collapsed;
        await _daemon.StartAsync();
    }

    private async void OnChooseRemote(object sender, RoutedEventArgs e)
    {
        var raw = RemoteUrlBox.Text?.Trim() ?? "";
        if (!Uri.TryCreate(raw, UriKind.Absolute, out var url) ||
            (url.Scheme != "http" && url.Scheme != "https"))
        {
            ShowRemoteError("Enter the full link, e.g. http://192.168.1.50:7777/?token=…");
            return;
        }
        var token = PanelLocator.TokenFromUrl(url);
        if (string.IsNullOrEmpty(token))
        {
            ShowRemoteError("That link has no token. Copy the whole link from the other device’s System tab.");
            return;
        }

        RemoteError.Visibility = Visibility.Collapsed;
        ConnectButton.IsEnabled = false;
        var label = ConnectButton.Content;
        ConnectButton.Content = "Connecting…";
        var ok = await _daemon.CanConnectAsync(url, token);
        ConnectButton.Content = label;
        ConnectButton.IsEnabled = true;
        if (!ok)
        {
            ShowRemoteError($"Couldn’t reach Modulus at {url.Host}. Check it’s running and on the same network.");
            return;
        }

        DesktopConfig.Save(new DesktopConfig { Mode = "remote", RemoteUrl = raw, RemoteToken = token });
        _daemon.ConfigureRemote(url, token);
        SetupOverlay.Visibility = Visibility.Collapsed;
        await _daemon.StartAsync();
    }

    private void ShowRemoteError(string message)
    {
        RemoteError.Text = message;
        RemoteError.Visibility = Visibility.Visible;
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
        // The Voice Hub needs the mic. The in-app panel is our own trusted local
        // origin, so grant microphone silently for it rather than making the user
        // chase a WebView2 permission prompt. Anything off-origin keeps default
        // (prompt) handling.
        core.PermissionRequested += (_, e) =>
        {
            if (e.PermissionKind == CoreWebView2PermissionKind.Microphone &&
                _panelUrl is not null &&
                Uri.TryCreate(e.Uri, UriKind.Absolute, out var origin) &&
                PanelLocator.Origin(origin) == PanelLocator.Origin(_panelUrl))
            {
                e.State = CoreWebView2PermissionState.Allow;
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
