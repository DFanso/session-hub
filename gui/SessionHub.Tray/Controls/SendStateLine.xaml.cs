using System;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Media;
using System.Windows.Media.Animation;

namespace SessionHub.Tray.Controls;

/// <summary>The send state line under a reply box or an answer form.</summary>
public partial class SendStateLine : UserControl
{
    public static readonly DependencyProperty TextMaxWidthProperty = DependencyProperty.Register(
        nameof(TextMaxWidth), typeof(double), typeof(SendStateLine), new PropertyMetadata(300.0));

    public SendStateLine()
    {
        InitializeComponent();
        Spinner.IsVisibleChanged += (_, _) => Spin(Spinner.IsVisible);
    }

    /// <summary>Widest the state text may be before it wraps (300 in a card).</summary>
    public double TextMaxWidth
    {
        get => (double)GetValue(TextMaxWidthProperty);
        set => SetValue(TextMaxWidthProperty, value);
    }

    private void Spin(bool on)
    {
        if (on && SystemParameters.ClientAreaAnimation)
        {
            SpinAngle.BeginAnimation(
                RotateTransform.AngleProperty,
                new DoubleAnimation(0, 360, TimeSpan.FromMilliseconds(800)) { RepeatBehavior = RepeatBehavior.Forever });
        }
        else
        {
            SpinAngle.BeginAnimation(RotateTransform.AngleProperty, null);
        }
    }
}
