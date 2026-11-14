using System;
using System.Windows;
using Microsoft.Win32;

namespace SessionHub.Tray;

/// <summary>
/// Follows the Windows app mode (<c>AppsUseLightTheme</c>, read only) and swaps the theme dictionary
/// live when it changes. Every brush is used through DynamicResource, so open views recolour at once.
/// </summary>
internal sealed class ThemeManager : IDisposable
{
    private const string PersonalizeKey = @"Software\Microsoft\Windows\CurrentVersion\Themes\Personalize";

    private readonly Application app;
    private bool? isLight;

    public ThemeManager(Application app)
    {
        this.app = app;
        Apply(ReadIsLight());
        SystemEvents.UserPreferenceChanged += OnPreferenceChanged;
    }

    /// <summary>True when Windows apps use the light theme (the Windows default when the value is missing).</summary>
    public static bool ReadIsLight()
    {
        try
        {
            using var key = Registry.CurrentUser.OpenSubKey(PersonalizeKey, writable: false);
            return key?.GetValue("AppsUseLightTheme") is not int v || v != 0;
        }
        catch (Exception e) when (e is System.Security.SecurityException or UnauthorizedAccessException or System.IO.IOException)
        {
            // Unreadable key: dark, the panel's own default look.
            TrayLog.Error("theme-read", e);
            return false;
        }
    }

    /// <summary>Loads one theme now (render check).</summary>
    public void Apply(bool light)
    {
        if (isLight == light) return;
        isLight = light;
        var dict = new ResourceDictionary
        {
            Source = new Uri(light ? "pack://application:,,,/Themes/Light.xaml" : "pack://application:,,,/Themes/Dark.xaml", UriKind.Absolute),
        };
        var merged = app.Resources.MergedDictionaries;
        if (merged.Count > 0) merged[0] = dict;
        else merged.Add(dict);
    }

    public void Dispose() => SystemEvents.UserPreferenceChanged -= OnPreferenceChanged;

    private void OnPreferenceChanged(object? sender, UserPreferenceChangedEventArgs e)
    {
        if (e.Category is not (UserPreferenceCategory.General or UserPreferenceCategory.Color or UserPreferenceCategory.VisualStyle)) return;
        app.Dispatcher.BeginInvoke(() => Apply(ReadIsLight()));
    }
}
