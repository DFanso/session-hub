using System;
using System.Globalization;
using System.IO;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Threading;
using System.Threading.Tasks;
using System.Windows;
using System.Windows.Interop;
using System.Windows.Media;
using System.Windows.Threading;
using SessionHub.Core.App;
using SessionHub.Core.Bridge;
using SessionHub.Core.Settings;

namespace SessionHub.Tray;

/// <summary>
/// Starts the tray: one instance per user session (a second start opens the panel of the first),
/// <c>run\tray.pid</c> for <c>hub install</c>, the quit event, error logging and the theme.
/// </summary>
[System.Diagnostics.CodeAnalysis.SuppressMessage("Design", "CA1001", Justification = "WPF Application lifetime: theme is disposed in OnExit; nothing calls Dispose on an Application.")]
public partial class App : Application
{
    private Mutex? instance;
    private EventWaitHandle? showEvent;
    private EventWaitHandle? quitEvent;
    private RegisteredWaitHandle? showWait;
    private RegisteredWaitHandle? quitWait;
    private string? pidFile;
    private ThemeManager? theme;
    private TrayController? tray;

    protected override void OnStartup(StartupEventArgs e)
    {
        base.OnStartup(e);

        // Software rendering for the whole process: the views are mostly text, and not creating a
        // Direct3D device saves about 70 MB of private memory (measured in the Task 7 report; a
        // per-window switch does not avoid the device). Spec §8.5 RAM target.
        RenderOptions.ProcessRenderMode = RenderMode.SoftwareOnly;
        if (!AppArgs.TryParse(e.Args, out var args, out _))
        {
            Shutdown(2);
            return;
        }

        if (args.RenderCheckDir is { } outDir)
        {
            theme = new ThemeManager(this);
            Shutdown(RenderCheck.Run(this, theme, outDir));
            return;
        }

        var dataDir = args.DataDir ?? SettingsStore.DefaultDirectory();
        var runDir = Path.Combine(dataDir, "run");
        try
        {
            Directory.CreateDirectory(runDir);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            // No place for a log line either.
            Shutdown(3);
            return;
        }

        TrayLog.Init(runDir);
        DispatcherUnhandledException += OnDispatcherUnhandled;
        TaskScheduler.UnobservedTaskException += OnUnobservedTask;
        AppDomain.CurrentDomain.UnhandledException += (_, ev) => TrayLog.Error("unhandled", ev.ExceptionObject as Exception);

        // The instance mutex and both events carry an ACL for the current user only. One that already
        // exists under another owner (or that this user may not open) stops the start: a foreign
        // process must not be able to quit or show this tray.
        var user = WindowsIdentity.GetCurrent().User!;
        bool first;
        try
        {
            instance = MutexAcl.Create(initiallyOwned: true, Native.InstanceMutexName, out first, MutexFor(user));
        }
        catch (Exception ex) when (ex is UnauthorizedAccessException or IOException or WaitHandleCannotBeOpenedException)
        {
            TrayLog.Error("instance-mutex", ex);
            Shutdown(4);
            return;
        }

        if (!first)
        {
            var signalled = SignalFirstInstance(runDir);
            instance.Dispose();
            instance = null;
            // Not signalled: the mutex is held by something that is not a running tray (or the show
            // event may not be opened). Never exit silently: the reason is in the log.
            Shutdown(signalled ? 0 : 6);
            return;
        }

        quitEvent = OwnEvent(Native.QuitEventName, user);
        showEvent = OwnEvent(Native.ShowEventName, user);
        if (quitEvent is null || showEvent is null)
        {
            Shutdown(5);
            return;
        }

        // Anything that fails from here (the pid file, the theme, the controller, the tray icon) is
        // logged and ends the start with exit code 7, never an unexplained crash dialog.
        try
        {
            pidFile = Path.Combine(runDir, "tray.pid");
            File.WriteAllText(pidFile, Environment.ProcessId.ToString(CultureInfo.InvariantCulture));

            theme = new ThemeManager(this);
            var controller = new TrayController(this, dataDir, HubBridgeProcess.Factory(args.HubPath));

            quitWait = ThreadPool.RegisterWaitForSingleObject(
                quitEvent, (_, _) => Dispatcher.BeginInvoke(() => controller.Quit(fromSignal: true)), null, Timeout.Infinite, executeOnlyOnce: true);
            showWait = ThreadPool.RegisterWaitForSingleObject(
                showEvent, (_, _) => Dispatcher.BeginInvoke(() => controller.ShowPanel(null)), null, Timeout.Infinite, executeOnlyOnce: false);

            controller.Start();

            // Only a started tray flushes its settings on exit: a start that failed may hold defaults
            // from a gui.json it could not read, which must not overwrite the file.
            tray = controller;
        }
        catch (Exception ex)
        {
            TrayLog.Error("startup", ex);
            Shutdown(7);
        }
    }

    protected override void OnExit(ExitEventArgs e)
    {
        tray?.FlushSettings();
        quitWait?.Unregister(null);
        showWait?.Unregister(null);
        quitEvent?.Dispose();
        showEvent?.Dispose();
        theme?.Dispose();
        if (pidFile is not null)
        {
            try
            {
                File.Delete(pidFile);
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
            {
                TrayLog.Error("pid-delete", ex);
            }
        }

        if (instance is not null)
        {
            instance.ReleaseMutex();
            instance.Dispose();
        }

        base.OnExit(e);
    }

    /// <summary>
    /// Asks the running tray to open its panel. The first instance may still be starting, so its show
    /// event can take a moment to appear (2 s). False, logged, when the event cannot be opened or set,
    /// or never appears (the instance mutex then belongs to something that is not a running tray).
    /// </summary>
    private static bool SignalFirstInstance(string runDir)
    {
        try
        {
            for (var i = 0; i < 20; i++)
            {
                if (EventWaitHandle.TryOpenExisting(Native.ShowEventName, out var show))
                {
                    // This start was launched by the user, so it may hand the foreground to the running tray.
                    if (ReadPid(Path.Combine(runDir, "tray.pid")) is { } pid) Native.AllowForegroundFor(pid);
                    using (show) show.Set();
                    return true;
                }

                Thread.Sleep(100);
            }

            TrayLog.Error("signal-first-instance-no-event", null);
            return false;
        }
        catch (Exception ex) when (ex is UnauthorizedAccessException or IOException or WaitHandleCannotBeOpenedException or ObjectDisposedException)
        {
            TrayLog.Error("signal-first-instance", ex);
            return false;
        }
    }

    private static int? ReadPid(string file)
    {
        try
        {
            return int.TryParse(File.ReadAllText(file).Trim(), NumberStyles.None, CultureInfo.InvariantCulture, out var pid) && pid > 0 ? pid : null;
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            return null;
        }
    }

    private static MutexSecurity MutexFor(SecurityIdentifier user)
    {
        var security = new MutexSecurity();
        security.SetAccessRuleProtection(isProtected: true, preserveInheritance: false);
        security.AddAccessRule(new MutexAccessRule(user, MutexRights.FullControl, AccessControlType.Allow));
        return security;
    }

    /// <summary>
    /// Creates (or opens) one auto-reset signal with a current-user-only ACL. Null, logged, when it
    /// exists under another owner or cannot be opened.
    /// </summary>
    private static EventWaitHandle? OwnEvent(string name, SecurityIdentifier user)
    {
        var security = new EventWaitHandleSecurity();
        security.SetAccessRuleProtection(isProtected: true, preserveInheritance: false);
        security.AddAccessRule(new EventWaitHandleAccessRule(user, EventWaitHandleRights.FullControl, AccessControlType.Allow));
        EventWaitHandle handle;
        try
        {
            handle = EventWaitHandleAcl.Create(false, EventResetMode.AutoReset, name, out var created, security);
            if (created) return handle;
        }
        catch (Exception ex) when (ex is UnauthorizedAccessException or IOException or WaitHandleCannotBeOpenedException)
        {
            TrayLog.Error("event-" + name, ex);
            return null;
        }

        try
        {
            if (handle.GetAccessControl().GetOwner(typeof(SecurityIdentifier)) is SecurityIdentifier owner && owner == user) return handle;
            TrayLog.Error("event-foreign-owner-" + name, null);
        }
        catch (Exception ex) when (ex is UnauthorizedAccessException or InvalidOperationException or IOException)
        {
            TrayLog.Error("event-owner-" + name, ex);
        }

        handle.Dispose();
        return null;
    }

    private void OnDispatcherUnhandled(object sender, DispatcherUnhandledExceptionEventArgs e)
    {
        TrayLog.Error("dispatcher", e.Exception);
        e.Handled = true;
    }

    private static void OnUnobservedTask(object? sender, UnobservedTaskExceptionEventArgs e)
    {
        TrayLog.Error("task", e.Exception);
        e.SetObserved();
    }
}
