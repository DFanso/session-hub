using System;
using System.Windows;
using System.Windows.Controls;

namespace SessionHub.Tray.Controls;

/// <summary>
/// A row whose children each get their own width plus an equal share of the space left over (CSS
/// <c>flex: 1</c> with nowrap content), so a wide tab like "Waiting 12" never gets clipped.
/// </summary>
public sealed class FlexRow : Panel
{
    protected override Size MeasureOverride(Size availableSize)
    {
        double width = 0, height = 0;
        foreach (UIElement child in InternalChildren)
        {
            child.Measure(new Size(double.PositiveInfinity, availableSize.Height));
            width += child.DesiredSize.Width;
            height = Math.Max(height, child.DesiredSize.Height);
        }

        return new Size(double.IsInfinity(availableSize.Width) ? width : Math.Max(width, availableSize.Width), height);
    }

    protected override Size ArrangeOverride(Size finalSize)
    {
        double natural = 0;
        foreach (UIElement child in InternalChildren) natural += child.DesiredSize.Width;
        var extra = InternalChildren.Count == 0 ? 0 : Math.Max(0, finalSize.Width - natural) / InternalChildren.Count;
        double x = 0;
        foreach (UIElement child in InternalChildren)
        {
            var w = child.DesiredSize.Width + extra;
            child.Arrange(new Rect(x, 0, w, finalSize.Height));
            x += w;
        }

        return finalSize;
    }
}
