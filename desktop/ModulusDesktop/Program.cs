using Microsoft.UI.Dispatching;
using Microsoft.UI.Xaml;
using Microsoft.Windows.AppLifecycle;

namespace ModulusDesktop;

public static class Program
{
    [STAThread]
    public static int Main(string[] args)
    {
        // Must run before anything else: handles Velopack's install/update/
        // uninstall hook invocations (shortcuts etc.) and exits early for them.
        Velopack.VelopackApp.Build().Run();

        WinRT.ComWrappersSupport.InitializeComWrappers();

        // Single instance: a second launch redirects to the running one, which
        // responds by showing its window.
        var instance = AppInstance.FindOrRegisterForKey("modulus-desktop");
        if (!instance.IsCurrent)
        {
            instance
                .RedirectActivationToAsync(AppInstance.GetCurrent().GetActivatedEventArgs())
                .AsTask()
                .Wait();
            return 0;
        }

        Application.Start(p =>
        {
            var context = new DispatcherQueueSynchronizationContext(
                DispatcherQueue.GetForCurrentThread());
            SynchronizationContext.SetSynchronizationContext(context);
            _ = new App();
        });
        return 0;
    }
}
