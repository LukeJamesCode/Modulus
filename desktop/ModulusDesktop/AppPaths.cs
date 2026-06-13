namespace ModulusDesktop;

// Dev vs installed layout. Installed: the daemon payload sits next to the exe
// (<install>/daemon/{node,app}). Dev: walk up from bin/ to the repo root and
// run the repo's dist/ build under the system Node.
public sealed class AppPaths
{
    public required string NodeExe { get; init; }
    public required string AppRoot { get; init; }
    public required bool Installed { get; init; }

    public static string ModulusHome =>
        Environment.GetEnvironmentVariable("MODULUS_HOME")
        ?? Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".modulus");

    public static string LogsDir =>
        Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            "Modulus", "logs");

    public string CliEntry => Path.Combine(AppRoot, "dist", "cli", "index.js");

    public static AppPaths Resolve()
    {
        var exeDir = AppContext.BaseDirectory;

        var installedApp = Path.Combine(exeDir, "daemon", "app");
        var installedNode = Path.Combine(exeDir, "daemon", "node", "node.exe");
        if (File.Exists(Path.Combine(installedApp, "dist", "cli", "index.js")))
        {
            return new AppPaths { NodeExe = installedNode, AppRoot = installedApp, Installed = true };
        }

        // Dev: find the repo root (contains package.json + dist/cli/index.js).
        var dir = new DirectoryInfo(exeDir);
        while (dir is not null)
        {
            if (File.Exists(Path.Combine(dir.FullName, "package.json")) &&
                File.Exists(Path.Combine(dir.FullName, "dist", "cli", "index.js")))
            {
                return new AppPaths { NodeExe = "node", AppRoot = dir.FullName, Installed = false };
            }
            dir = dir.Parent;
        }

        throw new InvalidOperationException(
            "Could not locate the Modulus daemon: no daemon/ payload next to the app " +
            "and no repo root with dist/cli/index.js above it. In dev, run `npm run build` first.");
    }
}
