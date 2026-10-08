using System;
using System.Threading;
using System.Reflection;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using System.Windows.Threading;
using KrillUsage;

// This synthetic harness is compiled separately with the real production class.
// It never loads the keyring, calls the vault, or supplies test modes to the shipped EXE.
internal static class CredentialPromptHarness
{
    private const string Token = "synthetic-window-token";
    private static int assertions;
    private static void Check(bool condition, string reason)
    {
        assertions++;
        if (!condition) throw new Exception(reason);
    }
    private static void Pump()
    {
        var frame = new DispatcherFrame();
        Dispatcher.CurrentDispatcher.BeginInvoke(DispatcherPriority.Background, new Action(delegate { frame.Continue = false; }));
        Dispatcher.PushFrame(frame);
    }
    private static CredentialWindow Open()
    {
        var window = new CredentialWindow();
        window.Show();
        window.Activate();
        window.Input.Focus();
        Pump();
        Check(window.Input.IsKeyboardFocused, "Synthetic GUI harness requires an interactive Windows desktop and focused PasswordBox.");
        return window;
    }
    private static void Paste(CredentialWindow window, string text)
    {
        Clipboard.SetText(text, TextDataFormat.UnicodeText);
        ApplicationCommands.Paste.Execute(null, window.Input);
        Pump();
    }
    private static void Click(Button button)
    {
        button.RaiseEvent(new RoutedEventArgs(Button.ClickEvent, button));
        Pump();
    }
    private static KeyEventArgs PressKey(CredentialWindow window, Key key)
    {
        var e = new KeyEventArgs(Keyboard.PrimaryDevice, PresentationSource.FromVisual(window), 0, key);
        e.RoutedEvent = Keyboard.PreviewKeyDownEvent;
        window.RaiseEvent(e);
        Pump();
        return e;
    }
    private static void Suite()
    {
        var window = Open();
        Paste(window, Token);
        Check(window.Input.Password == Token, "A real PasswordBox paste must preserve complete synthetic text.");
        Check(window.Save.IsEnabled, "Valid paste enables Save.");
        Check(window.TakeAccepted() == null, "Paste cannot implicitly submit.");
        Check(PressKey(window, Key.Enter).Handled, "Enter must be consumed.");
        Check(window.IsVisible && window.TakeAccepted() == null, "Enter cannot save or close.");
        window.Save.Focus();
        Check(PressKey(window, Key.Enter).Handled && window.IsVisible, "Enter while Save has focus cannot submit.");
        Click(window.Save);
        Check(window.TakeAccepted() == Token, "Explicit Save returns the exact value.");
        Check(window.Input.Password == "", "Closed UI clears its password.");
        Check(window.TakeAccepted() == null, "Accepted value is consumed once.");

        string[] badClipboard = { Token + "\r\n" + Token, Token + "\n", Token + "\t", Token + "\u0085", Token + "\u2028", Token + "\u2029", new string('x', CredentialRules.MaximumLength + 1) };
        foreach (string text in badClipboard)
        {
            window = Open();
            Paste(window, Token);
            Paste(window, text);
            Check(window.Input.Password == "", "Rejected whole paste must discard prior value and any prefix.");
            Check(!window.Save.IsEnabled && window.TakeAccepted() == null, "Rejected paste cannot be saved.");
            Click(window.Save); // Even a programmatic click cannot bypass validation.
            Check(window.IsVisible && window.TakeAccepted() == null, "Invalid save cannot close or accept a prefix.");
            Paste(window, Token + "-corrected");
            Click(window.Save);
            Check(window.TakeAccepted() == Token + "-corrected", "Fresh valid paste permits explicit correction.");
        }

        // Windows CF_UNICODETEXT is NUL-terminated. Test embedded NUL in the
        // event snapshot directly, without claiming the OS exposes text after NUL.
        window = Open();
        Paste(window, Token);
        var data = new DataObject();
        data.SetData(DataFormats.UnicodeText, Token + "\0suffix", false);
        var paste = new DataObjectPastingEventArgs(data, false, DataFormats.UnicodeText);
        window.Input.RaiseEvent(paste);
        Check(paste.CommandCancelled && window.Input.Password == "" && !window.Save.IsEnabled, "Embedded NUL in a complete paste event must reject the whole value.");
        window.Close();

        window = Open();
        Clipboard.SetText(Token + "\0suffix", TextDataFormat.UnicodeText);
        string delivered = Clipboard.GetText(TextDataFormat.UnicodeText);
        Check(delivered == Token, "CF_UNICODETEXT round-trip exposes text only through its first NUL.");
        ApplicationCommands.Paste.Execute(null, window.Input);
        Pump();
        Check(window.Input.Password == delivered, "Paste handles exactly the string delivered by Windows clipboard.");
        Check(window.TakeAccepted() == null, "Clipboard text, including a NUL-terminated prefix, never implicitly submits.");
        window.Close();

        window = Open();
        window.Input.Password = new string('x', CredentialRules.MaximumLength);
        Check(window.Save.IsEnabled, "Exact length limit is accepted without truncation.");
        var composition = new TextComposition(InputManager.Current, window.Input, "x");
        var input = new TextCompositionEventArgs(Keyboard.PrimaryDevice, composition);
        input.RoutedEvent = TextCompositionManager.PreviewTextInputEvent;
        window.Input.RaiseEvent(input);
        Check(input.Handled && window.Input.Password == "" && !window.Save.IsEnabled, "Over-limit typing is rejected before insertion and cannot save the previous prefix.");
        window.Close();

        foreach (string action in new string[] { "cancel", "escape", "close" })
        {
            window = Open();
            Paste(window, Token);
            if (action == "cancel") Click(window.Cancel);
            else if (action == "escape") PressKey(window, Key.Escape);
            else window.Close();
            Check(window.TakeAccepted() == null && window.Input.Password == "", "Cancel/Escape/close discards the synthetic credential.");
        }

        window = Open();
        Paste(window, Token);
        // Latch parent cancellation before its dispatcher callback runs, then
        // race a queued Save against that callback on the same actual class.
        window.CancelForParent();
        window.Save.RaiseEvent(new RoutedEventArgs(Button.ClickEvent, window.Save));
        Pump();
        Check(window.ParentGone && window.TakeAccepted() == null, "Parent EOF wins over a subsequently queued Save.");
        Check(!window.IsVisible && window.Input.Password == "", "Parent cancellation clears and closes UI.");
    }

    [STAThread]
    private static int Main(string[] args)
    {
        try
        {
            if (args.Length == 1 && args[0] == "guard") return CredentialProgram.HasProtocolPipes() ? 0 : 3;
            var application = new Application { ShutdownMode = ShutdownMode.OnExplicitShutdown };
            if (args.Length == 1 && (args[0] == "flow-save" || args[0] == "flow-cancel"))
            {
                Dispatcher.CurrentDispatcher.BeginInvoke(DispatcherPriority.Loaded, new Action(delegate {
                    Check(application.Windows.Count == 1, "Production entry point must open one credential window.");
                    var window = (CredentialWindow)application.Windows[0];
                    window.Activate();
                    window.Input.Focus();
                    Pump();
                    Check(window.Input.IsKeyboardFocused, "Production flow requires a focused PasswordBox on an interactive desktop.");
                    Paste(window, Token + "\u00e9");
                    Click(args[0] == "flow-save" ? window.Save : window.Cancel);
                }));
                // Invoke the actual production entry point in this separately
                // compiled harness. The shipped EXE has no test argument or hook.
                return (int)typeof(CredentialProgram).GetMethod("Main", BindingFlags.NonPublic | BindingFlags.Static).Invoke(null, null);
            }
            if (args.Length == 1 && args[0] == "parent-eof")
            {
                var window = new CredentialWindow();
                CredentialProgram.WatchParent(window);
                window.ShowDialog();
                Check(window.ParentGone && window.TakeAccepted() == null, "Closed parent pipe cancels without output.");
                return 0;
            }
            if (args.Length != 0) return 2;
            Suite();
            Console.WriteLine("Synthetic PasswordBox checks passed: " + assertions);
            return 0;
        }
        catch (Exception error)
        {
            // Assertions and framework errors contain only synthetic test data.
            Console.Error.WriteLine(error.GetType().Name + ": " + error.Message);
            return 1;
        }
        finally { try { Clipboard.Clear(); } catch {} }
    }
}
