using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using Microsoft.Win32;

namespace KrillUsage
{
    internal static class CredentialRules
    {
        internal const int MaximumLength = 16384;
        internal const int MaximumAccountLength = 320;
        internal const int MaximumPasswordLength = 4096;

        internal static bool IsValidAccount(string value)
        {
            return !String.IsNullOrWhiteSpace(value) && value.Length <= MaximumAccountLength && IsAllowedText(value);
        }
        internal static bool IsValidPassword(string value)
        {
            return !String.IsNullOrEmpty(value) && value.Length <= MaximumPasswordLength && IsAllowedText(value);
        }
        internal static string LoginJson(string account, string password, bool remember)
        {
            if (!IsValidAccount(account) || !IsValidPassword(password)) throw new ArgumentException();
            return "{\"account\":\"" + EscapeJson(account.Trim()) + "\",\"password\":\"" + EscapeJson(password) + "\",\"rememberPassword\":" + (remember ? "true" : "false") + "}";
        }
        private static string EscapeJson(string value)
        {
            return value.Replace("\\", "\\\\").Replace("\"", "\\\"");
        }

        internal static bool IsValid(string value)
        {
            return !String.IsNullOrWhiteSpace(value) && value.Length <= MaximumLength && IsAllowedText(value);
        }

        internal static bool IsAllowedText(string value)
        {
            if (value == null) return false;
            for (int i = 0; i < value.Length; i++)
            {
                char c = value[i];
                if (Char.IsControl(c) || c == '\u2028' || c == '\u2029') return false;
                if (Char.IsHighSurrogate(c))
                {
                    if (i + 1 >= value.Length || !Char.IsLowSurrogate(value[++i])) return false;
                }
                else if (Char.IsLowSurrogate(c)) return false;
            }
            return true;
        }
    }

    internal sealed class CredentialWindow : Window
    {
        internal readonly TextBox Account = new TextBox();
        internal readonly CheckBox RememberPassword = new CheckBox();
        private readonly bool login;
        internal readonly PasswordBox Input = new PasswordBox();
        internal readonly Button Save = new Button();
        internal readonly Button Cancel = new Button();
        private readonly TextBlock message = new TextBlock();
        private bool updating;
        private bool rejected;
        private string accepted;
        private int parentGone;

        internal bool ParentGone { get { return Thread.VolatileRead(ref parentGone) != 0; } }

        internal void CancelForParent()
        {
            Interlocked.Exchange(ref parentGone, 1);
            try { Dispatcher.BeginInvoke(new Action(delegate { accepted = null; Close(); })); } catch {}
        }

        internal CredentialWindow(bool loginMode = false)
        {
            login = loginMode;
            Title = login ? "Krill Usage - Sign in" : "Krill Usage - Save JWT";
            Width = 510;
            SizeToContent = SizeToContent.Height;
            ResizeMode = ResizeMode.NoResize;
            WindowStartupLocation = WindowStartupLocation.CenterScreen;
            var panel = new StackPanel { Margin = new Thickness(24) };
            panel.Children.Add(new TextBlock {
                Text = login ? "Sign in with your Krill account and password. Your login token will be stored in the Windows credential vault." : "Paste your account JWT below. It will be stored in your Windows credential vault. This login credential is not guaranteed read-only.",
                TextWrapping = TextWrapping.Wrap, Margin = new Thickness(0, 0, 0, 14)
            });
            panel.Children.Add(new TextBlock {
                Text = login ? "Pasting replaces the whole field. Choose Sign in to confirm." : "Pasting replaces the whole value. Choose Save to confirm.",
                TextWrapping = TextWrapping.Wrap, Margin = new Thickness(0, 0, 0, 8)
            });
            if (login)
            {
                panel.Children.Add(new TextBlock { Text = "Account", Margin = new Thickness(0, 0, 0, 4) });
                Account.MaxLength = 0;
                Account.MinHeight = 30;
                Account.AllowDrop = false;
                Account.AcceptsReturn = false;
                Account.AcceptsTab = false;
                Account.ContextMenu = null;
                InputMethod.SetIsInputMethodEnabled(Account, false);
                DataObject.AddPastingHandler(Account, OnAccountPaste);
                Account.TextChanged += delegate {
                    if (updating) return;
                    if (Account.Text.Length > 0 && !CredentialRules.IsValidAccount(Account.Text)) { RejectAccount(); return; }
                    UpdateSave();
                };
                Account.PreviewTextInput += delegate(object sender, TextCompositionEventArgs e) {
                    if (!CredentialRules.IsAllowedText(e.Text) || Account.Text.Length - Account.SelectionLength + e.Text.Length > CredentialRules.MaximumAccountLength)
                    { e.Handled = true; RejectAccount(); }
                };
                Account.PreviewDrop += delegate(object sender, DragEventArgs e) { e.Handled = true; RejectAccount(); };
                Account.PreviewDragOver += delegate(object sender, DragEventArgs e) { e.Effects = DragDropEffects.None; e.Handled = true; };
                panel.Children.Add(Account);
                panel.Children.Add(new TextBlock { Text = "Password", Margin = new Thickness(0, 12, 0, 4) });
            }
            Input.MaxLength = 0; // Never silently truncate before validating the entire input.
            Input.AllowDrop = false;
            Input.ContextMenu = null;
            Input.MinHeight = 30;
            Input.FontSize = 16;
            InputMethod.SetIsInputMethodEnabled(Input, false);
            DataObject.AddPastingHandler(Input, OnPaste);
            Input.PasswordChanged += OnPasswordChanged;
            Input.PreviewTextInput += delegate(object sender, TextCompositionEventArgs e) {
                if (!CredentialRules.IsAllowedText(e.Text) || Input.Password.Length + e.Text.Length > (login ? CredentialRules.MaximumPasswordLength : CredentialRules.MaximumLength))
                { e.Handled = true; Reject(); }
            };
            Input.PreviewDrop += delegate(object sender, DragEventArgs e) { e.Handled = true; Reject(); };
            Input.PreviewDragOver += delegate(object sender, DragEventArgs e) { e.Effects = DragDropEffects.None; e.Handled = true; };
            panel.Children.Add(Input);
            if (login)
            {
                RememberPassword.IsChecked = true;
                RememberPassword.Content = new TextBlock {
                    Text = "Remember my password in the Windows credential vault for automatic sign-in. Uncheck to save only the login token.",
                    TextWrapping = TextWrapping.Wrap
                };
                RememberPassword.Margin = new Thickness(0, 12, 0, 0);
                panel.Children.Add(RememberPassword);
            }
            message.TextWrapping = TextWrapping.Wrap;
            message.Margin = new Thickness(0, 10, 0, 12);
            panel.Children.Add(message);
            var buttons = new StackPanel { Orientation = Orientation.Horizontal, HorizontalAlignment = HorizontalAlignment.Right };
            Save.Content = login ? "Sign in" : "Save";
            Save.IsDefault = false;
            Save.IsEnabled = false;
            Save.MinWidth = 80;
            Save.Margin = new Thickness(0, 0, 8, 0);
            Save.Click += OnSave;
            Cancel.Content = "Cancel";
            Cancel.MinWidth = 80;
            Cancel.Click += delegate { Close(); };
            buttons.Children.Add(Save);
            buttons.Children.Add(Cancel);
            panel.Children.Add(buttons);
            Content = panel;
            PreviewKeyDown += delegate(object sender, KeyEventArgs e) {
                if (e.Key == Key.Enter || e.Key == Key.Return) e.Handled = true;
                if (e.Key == Key.Escape) { e.Handled = true; Close(); }
            };
            Closed += delegate {
                updating = true;
                Input.Clear();
                Account.Clear();
                Save.IsEnabled = false;
            };
            Loaded += delegate { if (login) Account.Focus(); else Input.Focus(); };
        }

        private bool ValidPassword(string value)
        {
            return login ? CredentialRules.IsValidPassword(value) : CredentialRules.IsValid(value);
        }
        private void UpdateSave()
        {
            Save.IsEnabled = ValidPassword(Input.Password) && (!login || CredentialRules.IsValidAccount(Account.Text));
        }
        private void RejectAccount()
        {
            updating = true;
            Account.Clear();
            updating = false;
            Save.IsEnabled = false;
            message.Text = "Enter one complete account (up to 320 characters), without line breaks or control characters.";
        }
        private void OnAccountPaste(object sender, DataObjectPastingEventArgs e)
        {
            e.CancelCommand();
            string text = null;
            try
            {
                if (e.DataObject.GetDataPresent(DataFormats.UnicodeText, false))
                    text = e.DataObject.GetData(DataFormats.UnicodeText, false) as string;
                else if (e.DataObject.GetDataPresent(DataFormats.Text, false))
                    text = e.DataObject.GetData(DataFormats.Text, false) as string;
                if (!CredentialRules.IsValidAccount(text)) { RejectAccount(); return; }
                updating = true;
                Account.Text = text;
                updating = false;
                UpdateSave();
            }
            catch { updating = false; RejectAccount(); }
            finally { text = null; }
        }

        private void Reject()
        {
            rejected = true;
            updating = true;
            Input.Clear();
            updating = false;
            Save.IsEnabled = false;
            message.Text = login ? "Input rejected. Enter one complete password (up to 4,096 characters), without line breaks or control characters." : "Input rejected. Paste one complete JWT (up to 16,384 characters), without line breaks or control characters.";
        }

        private void OnPaste(object sender, DataObjectPastingEventArgs e)
        {
            // Inspect the ORIGINAL clipboard data, before WPF inserts or truncates it.
            e.CancelCommand();
            string text = null;
            try
            {
                if (e.DataObject.GetDataPresent(DataFormats.UnicodeText, false))
                    text = e.DataObject.GetData(DataFormats.UnicodeText, false) as string;
                else if (e.DataObject.GetDataPresent(DataFormats.Text, false))
                    text = e.DataObject.GetData(DataFormats.Text, false) as string;
                if (!ValidPassword(text)) { Reject(); return; }
                updating = true;
                Input.Password = text;
                updating = false;
                rejected = false;
                UpdateSave();
                message.Text = login ? "Choose Sign in to confirm, or Cancel to discard." : "Choose Save to confirm, or Cancel to discard.";
            }
            catch { updating = false; Reject(); }
            finally { text = null; }
        }

        private void OnPasswordChanged(object sender, RoutedEventArgs e)
        {
            if (updating) return;
            string value = Input.Password;
            if (value.Length == 0) { Save.IsEnabled = false; return; }
            if (!ValidPassword(value)) { Reject(); return; }
            rejected = false;
            UpdateSave();
            message.Text = login ? "Choose Sign in to confirm, or Cancel to discard." : "Choose Save to confirm, or Cancel to discard.";
        }

        private void OnSave(object sender, RoutedEventArgs e)
        {
            string value = Input.Password;
            if (ParentGone) { Close(); return; }
            if (rejected || !ValidPassword(value)) { Reject(); return; }
            if (login && !CredentialRules.IsValidAccount(Account.Text)) { RejectAccount(); return; }
            accepted = login ? CredentialRules.LoginJson(Account.Text, value, RememberPassword.IsChecked == true) : value;
            Close();
        }

        internal string TakeAccepted()
        {
            string value = accepted;
            accepted = null;
            return ParentGone ? null : value;
        }
    }

    internal static class CredentialProgram
    {
        private const int StdInputHandle = -10;
        private const int StdOutputHandle = -11;
        private const uint FileTypePipe = 3;
        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern IntPtr GetStdHandle(int handle);
        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern uint GetFileType(IntPtr handle);

        private static bool IsPipe(int number)
        {
            IntPtr handle = GetStdHandle(number);
            return handle != IntPtr.Zero && handle != new IntPtr(-1) && GetFileType(handle) == FileTypePipe;
        }

        internal static bool HasProtocolPipes()
        {
            return IsPipe(StdInputHandle) && IsPipe(StdOutputHandle);
        }

        internal static void WatchParent(CredentialWindow window)
        {
            var watcher = new Thread(delegate() {
                try { Console.OpenStandardInput().ReadByte(); } catch {}
                // EOF or any unexpected input means the parent protocol has ended.
                window.CancelForParent();
            });
            watcher.IsBackground = true;
            watcher.Start();
        }

        private static bool HasSupportedRuntime()
        {
            if (Environment.OSVersion.Platform != PlatformID.Win32NT) return false;
            using (RegistryKey key = Registry.LocalMachine.OpenSubKey(@"SOFTWARE\Microsoft\NET Framework Setup\NDP\v4\Full"))
            {
                object release = key == null ? null : key.GetValue("Release");
                return release is int && (int)release >= 528040;
            }
        }

        [STAThread]
        private static int Main(string[] args)
        {
            // A direct console/file launch must never display an input window or emit a JWT.
            if (!HasProtocolPipes()) return 1;
            bool login = args.Length == 1 && args[0] == "--login";
            if (args.Length != 0 && !login) return 1;
            byte[] bytes = null;
            string value = null;
            try
            {
                if (!HasSupportedRuntime()) return 1;
                var window = new CredentialWindow(login);
                WatchParent(window);
                window.ShowDialog();
                value = window.TakeAccepted();
                if (value == null) return 130;
                if (!login && !CredentialRules.IsValid(value)) return 1;
                bytes = new UTF8Encoding(false, true).GetBytes(value);
                if (window.ParentGone) return 130;
                using (Stream output = Console.OpenStandardOutput())
                {
                    output.Write(bytes, 0, bytes.Length);
                    output.Flush();
                }
                return 0;
            }
            catch { return 1; }
            finally
            {
                value = null;
                if (bytes != null) Array.Clear(bytes, 0, bytes.Length);
            }
        }
    }
}
