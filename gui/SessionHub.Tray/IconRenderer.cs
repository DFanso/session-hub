using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.Drawing.Text;
using System.IO;
using SessionHub.Core.Tray;

namespace SessionHub.Tray;

/// <summary>
/// Draws the tray icon: the rounded-square app tile with the Lucide <c>terminal</c> glyph (spec §9),
/// neutral grey when running, orange with a white count badge when items wait, dark grey when the
/// daemon is stopped, red on error. Icons are cached per state and size.
/// </summary>
internal sealed class IconRenderer : IDisposable
{
    private static readonly Color Running = ColorTranslator.FromHtml("#9c8f84");
    private static readonly Color Stopped = ColorTranslator.FromHtml("#55524f");
    private static readonly Color Error = ColorTranslator.FromHtml("#e04848");
    private static readonly Color OrangeFrom = ColorTranslator.FromHtml("#ff8a63");
    private static readonly Color OrangeTo = ColorTranslator.FromHtml("#e0501f");
    private static readonly Color BadgeText = ColorTranslator.FromHtml("#c23f0b");

    private readonly Dictionary<(IconKind, string, int), Icon> cache = [];

    /// <summary>The badge text: the count, or "99+" above 99.</summary>
    public static string BadgeLabel(int count) => count > 99 ? "99+" : count.ToString(System.Globalization.CultureInfo.InvariantCulture);

    public Icon Get(IconState state, int size)
    {
        ArgumentNullException.ThrowIfNull(state);
        var badge = state.Kind == IconKind.Waiting && state.Count > 0 ? BadgeLabel(state.Count) : "";
        var key = (state.Kind, badge, size);
        if (cache.TryGetValue(key, out var icon)) return icon;
        using var bmp = Draw(state.Kind, badge, size);
        icon = ToIcon(bmp);
        cache[key] = icon;
        return icon;
    }

    public void Dispose()
    {
        foreach (var icon in cache.Values) icon.Dispose();
        cache.Clear();
    }

    public static Bitmap Draw(IconKind kind, string badge, int size)
    {
        var bmp = new Bitmap(size, size, PixelFormat.Format32bppArgb);
        using var g = Graphics.FromImage(bmp);
        g.SmoothingMode = SmoothingMode.AntiAlias;
        g.PixelOffsetMode = PixelOffsetMode.HighQuality;
        g.TextRenderingHint = TextRenderingHint.AntiAliasGridFit;
        g.Clear(Color.Transparent);

        var tile = new RectangleF(0, 0, size, size);
        using (var path = RoundRect(tile, size * 0.27f))
        using (var fill = TileBrush(kind, tile))
        {
            g.FillPath(fill, path);
        }

        // Lucide terminal: polyline 4,17 10,11 4,5 and line 12,19 20,19 in a 24 box; drawn at 60 %.
        var glyph = size * 0.62f;
        var unit = glyph / 24f;
        var ox = (size - glyph) / 2f;
        var oy = (size - glyph) / 2f;
        PointF P(float x, float y) => new(ox + (x * unit), oy + (y * unit));
        var glyphColor = kind == IconKind.Stopped ? Color.FromArgb(0xaa, 0xaa, 0xaa) : Color.White;
        using (var pen = new Pen(glyphColor, Math.Max(1.4f, 2.4f * unit)) { StartCap = LineCap.Round, EndCap = LineCap.Round, LineJoin = LineJoin.Round })
        {
            g.DrawLines(pen, [P(4, 17), P(10, 11), P(4, 5)]);
            g.DrawLine(pen, P(12, 19), P(20, 19));
        }

        if (badge.Length > 0) DrawBadge(g, badge, size);
        return bmp;
    }

    private static void DrawBadge(Graphics g, string text, int size)
    {
        var h = (float)Math.Round(size * 0.58);
        using var font = new Font("Segoe UI", h * 0.78f, FontStyle.Bold, GraphicsUnit.Pixel);
        using var format = new StringFormat(StringFormat.GenericTypographic)
        {
            Alignment = StringAlignment.Center,
            LineAlignment = StringAlignment.Center,
            FormatFlags = StringFormatFlags.NoWrap,
        };
        var textW = g.MeasureString(text, font, int.MaxValue, format).Width;
        var w = Math.Min(size, Math.Max(h, textW + (h * 0.35f)));
        var rect = new RectangleF(size - w, size - h, w, h);
        using (var path = RoundRect(rect, h / 2f))
        using (var white = new SolidBrush(Color.White))
        {
            g.FillPath(white, path);
        }

        using var ink = new SolidBrush(BadgeText);
        g.DrawString(text, font, ink, new RectangleF(rect.X, rect.Y + (h * 0.04f), rect.Width, rect.Height), format);
    }

    private static Brush TileBrush(IconKind kind, RectangleF tile) => kind switch
    {
        IconKind.Waiting => new LinearGradientBrush(tile, OrangeFrom, OrangeTo, 45f),
        IconKind.Stopped => new SolidBrush(Stopped),
        IconKind.Error => new SolidBrush(Error),
        _ => new SolidBrush(Running),
    };

    private static GraphicsPath RoundRect(RectangleF r, float radius)
    {
        var d = Math.Min(radius * 2, Math.Min(r.Width, r.Height));
        var path = new GraphicsPath();
        path.AddArc(r.X, r.Y, d, d, 180, 90);
        path.AddArc(r.Right - d, r.Y, d, d, 270, 90);
        path.AddArc(r.Right - d, r.Bottom - d, d, d, 0, 90);
        path.AddArc(r.X, r.Bottom - d, d, d, 90, 90);
        path.CloseFigure();
        return path;
    }

    /// <summary>
    /// Wraps a 32-bit bitmap in a one-image ICO (a DIB entry with alpha), so the Icon owns its handle
    /// and Dispose frees it.
    /// </summary>
    private static Icon ToIcon(Bitmap bmp)
    {
        int w = bmp.Width, h = bmp.Height;
        var maskStride = ((w + 31) / 32) * 4;
        var pixelBytes = w * h * 4;
        var maskBytes = maskStride * h;
        var imageSize = 40 + pixelBytes + maskBytes;

        using var ms = new MemoryStream();
        using (var bw = new BinaryWriter(ms, System.Text.Encoding.UTF8, leaveOpen: true))
        {
            bw.Write((short)0);
            bw.Write((short)1);
            bw.Write((short)1);
            bw.Write((byte)(w >= 256 ? 0 : w));
            bw.Write((byte)(h >= 256 ? 0 : h));
            bw.Write((byte)0);
            bw.Write((byte)0);
            bw.Write((short)1);
            bw.Write((short)32);
            bw.Write(imageSize);
            bw.Write(6 + 16);

            bw.Write(40);
            bw.Write(w);
            bw.Write(h * 2);
            bw.Write((short)1);
            bw.Write((short)32);
            bw.Write(0);
            bw.Write(pixelBytes + maskBytes);
            bw.Write(0);
            bw.Write(0);
            bw.Write(0);
            bw.Write(0);

            var data = bmp.LockBits(new Rectangle(0, 0, w, h), ImageLockMode.ReadOnly, PixelFormat.Format32bppArgb);
            try
            {
                var row = new byte[w * 4];
                for (var y = h - 1; y >= 0; y--)
                {
                    System.Runtime.InteropServices.Marshal.Copy(data.Scan0 + (y * data.Stride), row, 0, row.Length);
                    bw.Write(row);
                }
            }
            finally
            {
                bmp.UnlockBits(data);
            }

            bw.Write(new byte[maskBytes]);
        }

        ms.Position = 0;
        return new Icon(ms, w, h);
    }
}
