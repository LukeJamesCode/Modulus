using System.Text.Json;

namespace ModulusDesktop;

// Remembers whether this app runs its own local engine or connects to a remote
// one (e.g. an always-on mini PC). Stored at %LOCALAPPDATA%\Modulus\desktop.json,
// separate from the engine's ~/.modulus config — this is a frontend preference,
// not engine state. Absent file = first run, so the app shows the chooser.
public sealed class DesktopConfig
{
    public string Mode { get; set; } = "local"; // "local" | "remote"

    // Full tokenized panel link the user pasted, e.g.
    // http://192.168.1.50:7777/?token=… — the WebView navigates straight to it.
    public string? RemoteUrl { get; set; }
    public string? RemoteToken { get; set; }

    private static string FilePath => Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
        "Modulus", "desktop.json");

    public static DesktopConfig? Load()
    {
        try
        {
            if (!File.Exists(FilePath)) return null;
            return JsonSerializer.Deserialize<DesktopConfig>(File.ReadAllText(FilePath));
        }
        catch (Exception e)
        {
            DaemonLog.Write($"desktop config load failed: {e.Message}");
            return null;
        }
    }

    public static void Save(DesktopConfig cfg)
    {
        try
        {
            Directory.CreateDirectory(Path.GetDirectoryName(FilePath)!);
            File.WriteAllText(
                FilePath,
                JsonSerializer.Serialize(cfg, new JsonSerializerOptions { WriteIndented = true }));
        }
        catch (Exception e)
        {
            DaemonLog.Write($"desktop config save failed: {e.Message}");
        }
    }
}
