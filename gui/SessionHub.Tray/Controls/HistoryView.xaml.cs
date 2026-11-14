using System;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using System.Windows.Media;
using System.Windows.Threading;
using SessionHub.Core.App;

namespace SessionHub.Tray.Controls;

/// <summary>
/// The window's History tab. Keeps the reading position: new messages follow only when the list was
/// already at the bottom; otherwise (and on "Load older") the first row on screen stays where it was.
/// DataContext: HistoryViewModel.
/// </summary>
public partial class HistoryView : UserControl
{
    private HistoryViewModel? vm;

    public HistoryView()
    {
        InitializeComponent();
        DataContextChanged += (_, _) => Attach(DataContext as HistoryViewModel);
        Unloaded += (_, _) => Attach(null);
        Loaded += (_, _) => Attach(DataContext as HistoryViewModel);
    }

    /// <summary>Puts the caret in the search box (Ctrl+F on the History tab).</summary>
    public void FocusSearch()
    {
        Search.Focus();
        Search.SelectAll();
    }

    /// <summary>The scroll viewer of the message list (the render check scrolls it).</summary>
    public ScrollViewer? MessageScroller
    {
        get
        {
            Messages.ApplyTemplate();
            return VisualTreeHelper.GetChildrenCount(Messages) > 0 ? VisualTreeHelper.GetChild(Messages, 0) as ScrollViewer : null;
        }
    }

    private void Attach(HistoryViewModel? next)
    {
        if (ReferenceEquals(vm, next)) return;
        if (vm is not null) vm.Changing -= OnChanging;
        vm = next;
        if (vm is not null) vm.Changing += OnChanging;
        SearchHint.Visibility = string.IsNullOrEmpty(Search.Text) ? Visibility.Visible : Visibility.Collapsed;
    }

    /// <summary>
    /// Reads the position before the rows change and restores it once the list has measured them.
    /// Each change keeps its own snapshot (the closure), so changes close together cannot mix them up.
    /// </summary>
    private void OnChanging(HistoryChange change)
    {
        var sv = MessageScroller;
        if (sv is null) return;
        var atBottom = sv.ScrollableHeight <= 0 || sv.VerticalOffset >= sv.ScrollableHeight - 2;
        var anchor = FirstVisible(sv);
        Dispatcher.BeginInvoke(() => Restore(sv, change, atBottom, anchor), DispatcherPriority.Loaded);
    }

    private void Restore(ScrollViewer sv, HistoryChange change, bool atBottom, (HistoryLine Line, double Top)? anchor)
    {
        if (change == HistoryChange.Replaced || (change == HistoryChange.Appended && atBottom))
        {
            sv.ScrollToEnd();
            return;
        }

        if (anchor is not { } a || vm is null) return;
        var index = vm.Lines.IndexOf(a.Line);
        if (index < 0) return;
        if (ItemsHost() is VirtualizingStackPanel panel) panel.BringIndexIntoViewPublic(index);
        sv.UpdateLayout();
        if (Messages.ItemContainerGenerator.ContainerFromIndex(index) is not FrameworkElement row) return;
        var top = TopOf(row, sv);
        sv.ScrollToVerticalOffset(sv.VerticalOffset + (top - a.Top));
    }

    /// <summary>The first row whose bottom is below the top of the viewport, and its top in the viewer.</summary>
    private (HistoryLine Line, double Top)? FirstVisible(ScrollViewer sv)
    {
        if (ItemsHost() is not Panel panel) return null;
        (HistoryLine, double)? best = null;
        foreach (UIElement child in panel.Children)
        {
            if (child is not FrameworkElement row || !row.IsVisible) continue;
            if (Messages.ItemContainerGenerator.ItemFromContainer(row) is not HistoryLine line) continue;
            var top = TopOf(row, sv);
            if (top + row.ActualHeight <= 0) continue;
            if (best is not { } b || top < b.Item2) best = (line, top);
        }

        return best;
    }

    private static double TopOf(FrameworkElement row, ScrollViewer sv) => row.TransformToAncestor(sv).Transform(new Point(0, 0)).Y;

    private VirtualizingStackPanel? ItemsHost() => Find<VirtualizingStackPanel>(Messages);

    private static T? Find<T>(DependencyObject root)
        where T : DependencyObject
    {
        for (var i = 0; i < VisualTreeHelper.GetChildrenCount(root); i++)
        {
            var child = VisualTreeHelper.GetChild(root, i);
            if (child is T hit) return hit;
            if (Find<T>(child) is { } deeper) return deeper;
        }

        return null;
    }

    private async void OnLoadOlder(object sender, RoutedEventArgs e)
    {
        if (vm is null) return;
        try
        {
            await vm.LoadOlderAsync();
        }
        catch (Exception ex)
        {
            TrayLog.Error("history-older", ex);
        }
    }

    private void OnSearchChanged(object sender, TextChangedEventArgs e) =>
        SearchHint.Visibility = Search.Text.Length == 0 ? Visibility.Visible : Visibility.Collapsed;

    private void OnSearchKey(object sender, KeyEventArgs e)
    {
        if (e.Key != Key.Escape || Search.Text.Length == 0) return;
        Search.Clear();
        e.Handled = true;
    }
}
