//! Length helpers: the TypeScript original counts string lengths in UTF-16 code units.

/// Length of `s` in UTF-16 code units (JS `.length`).
pub fn utf16_len(s: &str) -> usize {
    s.encode_utf16().count()
}

/// Longest prefix of `s` that is at most `max_units` UTF-16 units and ends on a char boundary.
pub fn clip_utf16(s: &str, max_units: usize) -> &str {
    let mut units = 0;
    for (i, c) in s.char_indices() {
        units += c.len_utf16();
        if units > max_units {
            return &s[..i];
        }
    }
    s
}
