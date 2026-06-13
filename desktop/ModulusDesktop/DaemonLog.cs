namespace ModulusDesktop;

// Shell-side log: daemon stdout/stderr plus shell lifecycle events. Pre-boot
// daemon failures land here; steady-state daemon logs go to
// ~/.modulus/log/modulus.log as usual.
public static class DaemonLog
{
    private static readonly object Gate = new();
    private const long MaxBytes = 5 * 1024 * 1024;

    public static string FilePath => Path.Combine(AppPaths.LogsDir, "daemon-stdio.log");

    public static void Write(string line)
    {
        try
        {
            lock (Gate)
            {
                Directory.CreateDirectory(AppPaths.LogsDir);
                var file = new FileInfo(FilePath);
                if (file.Exists && file.Length > MaxBytes)
                {
                    var old = FilePath + ".1";
                    File.Delete(old);
                    File.Move(FilePath, old);
                }
                File.AppendAllText(FilePath, $"{DateTime.Now:yyyy-MM-dd HH:mm:ss} {line}{Environment.NewLine}");
            }
        }
        catch
        {
            // Logging must never take the app down.
        }
    }
}
