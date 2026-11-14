using System;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using SessionHub.Core.App;

namespace SessionHub.Tray.Controls;

/// <summary>Reply box of a card or of the Send tab. Enter sends, Shift+Enter adds a line.</summary>
public partial class SendBox : UserControl
{
    public SendBox()
    {
        InitializeComponent();
        DataContextChanged += (_, _) => UpdatePlaceholder();
    }

    /// <summary>Puts the caret in the box (Send tab, Ctrl+F style shortcuts).</summary>
    public void FocusInput()
    {
        Input.Focus();
        Input.CaretIndex = Input.Text.Length;
    }

    private void OnInputKeyDown(object sender, KeyEventArgs e)
    {
        if (e.Key != Key.Enter) return;
        e.Handled = true;
        if ((Keyboard.Modifiers & ModifierKeys.Shift) != 0)
        {
            var at = Input.CaretIndex;
            Input.SelectedText = Environment.NewLine;
            Input.CaretIndex = at + Environment.NewLine.Length;
            Input.SelectionLength = 0;
            return;
        }

        if (PanelCommands.Send.CanExecute(DataContext, this)) PanelCommands.Send.Execute(DataContext, this);
    }

    private void OnFocusChanged(object sender, KeyboardFocusChangedEventArgs e) =>
        Field.SetResourceReference(Border.BorderBrushProperty, Input.IsKeyboardFocused ? "Accent" : "Line");

    private void OnTextChanged(object sender, TextChangedEventArgs e) => UpdatePlaceholder();

    private void UpdatePlaceholder()
    {
        var name = (DataContext as CardViewModel)?.Session.Name ?? "the session";
        Placeholder.Text = $"Message {name}… (Enter sends, Shift+Enter new line)";
        Placeholder.Visibility = Input.Text.Length == 0 ? Visibility.Visible : Visibility.Collapsed;
    }
}
