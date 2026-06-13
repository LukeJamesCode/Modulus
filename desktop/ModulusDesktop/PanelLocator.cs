using System.Text.Json;
using System.Text.RegularExpressions;

namespace ModulusDesktop;

// Resolves the panel URL + token: primary source is the tokenized URL the
// daemon prints to stdout; fallback is ~/.modulus/panel-token + config.json.
public static partial class PanelLocator
{
    [GeneratedRegex(@"http://\S+\?token=\S+")]
    private static partial Regex UrlRegex();

    public static Uri? FromStdoutLine(string line)
    {
        var m = UrlRegex().Match(line);
        if (!m.Success) return null;
        return Uri.TryCreate(m.Value, UriKind.Absolute, out var uri) ? uri : null;
    }

    public static Uri? FromFiles(string modulusHome)
    {
        var tokenFile = Path.Combine(modulusHome, "panel-token");
        if (!File.Exists(tokenFile)) return null;
        var token = File.ReadAllText(tokenFile).Trim();
        if (token.Length == 0) return null;

        var port = 7777;
        var configFile = Path.Combine(modulusHome, "config.json");
        if (File.Exists(configFile))
        {
            try
            {
                using var doc = JsonDocument.Parse(File.ReadAllText(configFile));
                if (doc.RootElement.TryGetProperty("panel", out var panel) &&
                    panel.TryGetProperty("port", out var p) &&
                    p.TryGetInt32(out var n))
                {
                    port = n;
                }
            }
            catch (JsonException) { /* malformed config — keep default port */ }
        }

        return new Uri($"http://127.0.0.1:{port}/?token={token}");
    }

    public static string? TokenFromUrl(Uri url)
    {
        var q = url.Query.TrimStart('?');
        foreach (var pair in q.Split('&', StringSplitOptions.RemoveEmptyEntries))
        {
            if (pair.StartsWith("token=", StringComparison.Ordinal))
                return Uri.UnescapeDataString(pair["token=".Length..]);
        }
        return null;
    }

    public static Uri Origin(Uri url) => new($"{url.Scheme}://{url.Host}:{url.Port}/");
}
