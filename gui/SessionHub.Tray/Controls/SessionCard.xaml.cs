using System;
using System.ComponentModel;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Media.Animation;
using SessionHub.Core.App;

namespace SessionHub.Tray.Controls;

/// <summary>Expandable session card (panel design 1). DataContext: CardViewModel.</summary>
public partial class SessionCard : UserControl
{
    private CardViewModel? card;

    public SessionCard()
    {
        InitializeComponent();
        // Containers are recycled: follow whichever card this one shows now.
        DataContextChanged += (_, _) =>
        {
            Unsubscribe();
            if (IsLoaded) Subscribe();
            Flash.BeginAnimation(OpacityProperty, null);
            Flash.Opacity = 0;
        };

        // A card that left the visual tree must not keep its view model's event alive.
        Loaded += (_, _) => Subscribe();
        Unloaded += (_, _) => Unsubscribe();
    }

    private void Subscribe()
    {
        Unsubscribe();
        card = DataContext as CardViewModel;
        if (card is not null) card.PropertyChanged += OnCardChanged;
    }

    private void Unsubscribe()
    {
        if (card is not null) card.PropertyChanged -= OnCardChanged;
        card = null;
    }

    private void OnCardChanged(object? sender, PropertyChangedEventArgs e)
    {
        if (e.PropertyName != nameof(CardViewModel.Revision) || !SystemParameters.ClientAreaAnimation) return;
        Flash.BeginAnimation(OpacityProperty, new DoubleAnimation(1, 0, TimeSpan.FromMilliseconds(1600)) { EasingFunction = new QuadraticEase { EasingMode = EasingMode.EaseOut } });
    }
}
