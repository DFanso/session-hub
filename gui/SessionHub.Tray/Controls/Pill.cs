using System;
using System.Windows;
using System.Windows.Controls;

namespace SessionHub.Tray.Controls;

/// <summary>A border whose corners are always half its height (CSS radius 999). WPF would draw a larger radius as an ellipse.</summary>
public sealed class Pill : Border
{
    protected override Size ArrangeOverride(Size finalSize)
    {
        var size = base.ArrangeOverride(finalSize);
        var radius = new CornerRadius(Math.Min(finalSize.Width, finalSize.Height) / 2);
        if (CornerRadius != radius) CornerRadius = radius;
        return size;
    }
}
