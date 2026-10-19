//! Repair CJK-radical lookalikes in the ToUnicode CMaps of a finished PDF (#166).
//!
//! WebKitGTK prints through cairo, whose font subsetting reverse-maps glyphs to
//! the first cmap entry that names them. Noto CJK fonts map both the unified
//! ideograph and its Kangxi-radical / CJK-Radicals-Supplement lookalike to the
//! same glyph, so the exported PDF extracts 文 as ⽂ (U+2F42), 页 as ⻚
//! (U+2EDA), 一 as ⼀ (U+2F00) … — copy, search and screen readers get the
//! wrong codepoints. (macOS avoids this by rebuilding ToUnicode from the
//! original CID font; see `pdf_post_macos`.)
//!
//! `repair_radical_tounicode` post-processes such a PDF as an incremental
//! update: every ToUnicode CMap entry whose destination is a single char in
//! U+2E80–U+2EFF or U+2F00–U+2FD5 is rewritten to its unified-ideograph
//! equivalent — via NFKC, falling back to a small table of supplement radicals
//! that have no Unicode decomposition but share a Noto glyph with a unified
//! ideograph (⻚→页, ⻁→虎, ⺠→民 …). Anything not understood is left untouched,
//! so the worst case is the status quo, never a broken export.

use flate2::Compression;
use flate2::read::ZlibDecoder;
use flate2::write::ZlibEncoder;
use std::io::{Read, Write};
use unicode_normalization::UnicodeNormalization;

/// Supplement radicals without an NFKC decomposition whose glyph is shared
/// with a unified ideograph in the Noto CJK fonts (what WebKitGTK substitutes
/// for CJK text). Derived from the fonts' cmaps — a radical is listed only
/// when a unified ideograph maps to the very same glyph ID (smallest such cp,
/// URO preferred over ext-A / compatibility ideographs) — which is exactly
/// the confusion cairo's reverse mapping produces.
const GLYPH_SHARED_RADICALS: &[(u32, u32)] = &[
    (0x2E85, 0x4EBB),
    (0x2E89, 0x5202),
    (0x2E8E, 0xFA0C),
    (0x2E8F, 0x5C23),
    (0x2E90, 0x5C22),
    (0x2E93, 0x5E7A),
    (0x2E94, 0x5F51),
    (0x2E95, 0x5F50),
    (0x2E96, 0x5FC4),
    (0x2E99, 0x6535),
    (0x2E9B, 0x65E1),
    (0x2E9E, 0x6B7A),
    (0x2EA0, 0x6C11),
    (0x2EA1, 0x6C35),
    (0x2EA3, 0x706C),
    (0x2EA4, 0x722B),
    (0x2EA6, 0x4E2C),
    (0x2EAB, 0x7F52),
    (0x2EAD, 0x793B),
    (0x2EAF, 0x7CF9),
    (0x2EB0, 0x7E9F),
    (0x2EB1, 0x7F53),
    (0x2EB2, 0x7F52),
    (0x2EB3, 0x34C1),
    (0x2EB9, 0x8002),
    (0x2EBE, 0x8279),
    (0x2EBF, 0x8279),
    (0x2EC1, 0x864E),
    (0x2EC2, 0x8864),
    (0x2EC3, 0x8980),
    (0x2EC4, 0x897F),
    (0x2EC5, 0x89C1),
    (0x2EC6, 0x89D2),
    (0x2EC8, 0x8BA0),
    (0x2EC9, 0x8D1D),
    (0x2ECB, 0x8F66),
    (0x2ECC, 0x8FB6),
    (0x2ECE, 0x8FB6),
    (0x2ED1, 0x9577),
    (0x2ED2, 0x9578),
    (0x2ED3, 0x957F),
    (0x2ED4, 0x95E8),
    (0x2ED9, 0x97E6),
    (0x2EDA, 0x9875),
    (0x2EDD, 0x98DF),
    (0x2EDF, 0x98E0),
    (0x2EE0, 0x9963),
    (0x2EE3, 0x9AA8),
    (0x2EE4, 0x9B3C),
    (0x2EE6, 0x9E1F),
    (0x2EE8, 0x9EA6),
    (0x2EE9, 0x9EC4),
    (0x2EEA, 0x9EFE),
    (0x2EEB, 0x6589),
    (0x2EEC, 0x9F50),
    (0x2EEE, 0x9F7F),
    (0x2EEF, 0x7ADC),
    (0x2EF0, 0x9F99),
    (0x2EF1, 0xF907),
    (0x2EF2, 0x4E80),
];

fn is_cjk_radical(c: char) -> bool {
    // CJK Radicals Supplement (U+2E80–U+2EFF) directly followed by the
    // Kangxi Radicals block (U+2F00–U+2FD5) — one contiguous range.
    matches!(c as u32, 0x2E80..=0x2FD5)
}

/// Unified-ideograph equivalent of a CJK radical, when there is exactly one.
fn unified_equivalent(c: char) -> Option<char> {
    if !is_cjk_radical(c) {
        return None;
    }
    // NFKC covers the whole Kangxi block (⼀→一, ⽂→文 …) and part of the
    // supplement; only single-char results are safe to substitute.
    let mut nfkc = c.nfkc();
    match (nfkc.next(), nfkc.next()) {
        (Some(a), None) if a != c => return Some(a),
        (Some(_), Some(_)) => return None, // multi-char decomposition: no single target
        _ => {}                            // unchanged → fall through to the glyph-sharing table
    }
    GLYPH_SHARED_RADICALS
        .binary_search_by(|&(r, _)| r.cmp(&(c as u32)))
        .ok()
        .and_then(|i| char::from_u32(GLYPH_SHARED_RADICALS[i].1))
        .filter(|&u| u != c)
}

/// Repair a PDF as an incremental update. `None` = nothing to repair (or the
/// structure was not understood); the caller then keeps the original bytes.
pub fn repair_radical_tounicode(pdf: &[u8]) -> Option<Vec<u8>> {
    let (trailer_start, trailer_end) = trailer_dict(pdf)?;
    if has(&pdf[trailer_start..trailer_end], b"/Encrypt") {
        return None; // never touch encrypted files
    }
    let old_xref = startxref_value(pdf, trailer_end)?;

    let mut fixed: Vec<(u32, Vec<u8>)> = Vec::new(); // (obj num, replacement object)
    for s in find_cmap_streams(pdf) {
        if let Some(cmap) = repair_cmap(&s.data) {
            let object = build_object(s.obj_num, &s.dict, &cmap, s.flate);
            fixed.push((s.obj_num, object));
        }
    }
    if fixed.is_empty() {
        return None;
    }
    fixed.sort_unstable_by_key(|(obj, _)| *obj);
    fixed.dedup_by_key(|(obj, _)| *obj);

    let mut out = pdf.to_vec();
    if out.last() != Some(&b'\n') {
        out.push(b'\n');
    }
    let mut offsets: Vec<(u32, usize)> = Vec::new();
    for (obj, object) in &fixed {
        offsets.push((*obj, out.len()));
        out.extend_from_slice(object);
    }
    let xref_at = out.len();
    out.extend_from_slice(b"xref\n");
    let mut i = 0;
    while i < offsets.len() {
        let mut j = i;
        while j + 1 < offsets.len() && offsets[j + 1].0 == offsets[j].0 + 1 {
            j += 1;
        }
        out.extend_from_slice(format!("{} {}\n", offsets[i].0, j - i + 1).as_bytes());
        for (_, off) in &offsets[i..=j] {
            out.extend_from_slice(format!("{off:010} 00000 n \n").as_bytes());
        }
        i = j + 1;
    }
    // Copy the original trailer (Root/Info/Size stay), add /Prev.
    let mut trailer = pdf[trailer_start..trailer_end].to_vec();
    let close = trailer.len() - 2; // before the closing ">>"
    trailer.splice(close..close, format!(" /Prev {old_xref}").into_bytes());
    out.extend_from_slice(b"trailer\n");
    out.extend_from_slice(&trailer);
    out.extend_from_slice(format!("\nstartxref\n{xref_at}\n%%EOF\n").as_bytes());
    Some(out)
}

struct CMapStream {
    obj_num: u32,
    dict: Vec<u8>,
    data: Vec<u8>, // decoded content
    flate: bool,
}

fn find_cmap_streams(pdf: &[u8]) -> Vec<CMapStream> {
    let mut found = Vec::new();
    let mut i = 0;
    while let Some(p) = find_from(pdf, b"stream", i) {
        i = p + 6;
        // keyword boundaries: preceded by whitespace or '>', followed by an EOL
        if !(p > 0 && (pdf[p - 1].is_ascii_whitespace() || pdf[p - 1] == b'>')) {
            continue;
        }
        let data_start = if pdf[i..].starts_with(b"\r\n") {
            i + 2
        } else if pdf[i..].starts_with(b"\n") || pdf[i..].starts_with(b"\r") {
            i + 1
        } else {
            continue;
        };
        let Some((obj_num, dict_start, dict_end)) = enclosing_object(pdf, p) else {
            continue;
        };
        let dict = &pdf[dict_start..dict_end];
        if has(dict, b"/XRef") || (has(dict, b"/Filter") && !has(dict, b"/FlateDecode")) {
            continue; // only plain and FlateDecode streams
        }
        let flate = has(dict, b"/FlateDecode");
        let Some(data_end) = stream_data_end(pdf, dict, data_start) else {
            continue;
        };
        let raw = &pdf[data_start..data_end];
        let data = if flate {
            let mut dec = ZlibDecoder::new(raw);
            let mut buf = Vec::new();
            if dec.read_to_end(&mut buf).is_err() {
                continue;
            }
            buf
        } else {
            raw.to_vec()
        };
        // ToUnicode CMaps (the only thing cairo embeds with bf sections);
        // encoding CMaps use a non-UCS registry.
        if has(&data, b"begincmap")
            && has(&data, b"(UCS)")
            && (has(&data, b"beginbfchar") || has(&data, b"beginbfrange"))
        {
            found.push(CMapStream {
                obj_num,
                dict: dict.to_vec(),
                data,
                flate,
            });
        }
    }
    found
}

/// Object number and `<<dict>>` span of the object whose stream keyword sits
/// at `stream_at`.
fn enclosing_object(pdf: &[u8], stream_at: usize) -> Option<(u32, usize, usize)> {
    let head = &pdf[..stream_at];
    let obj_at = head.windows(3).rposition(|w| w == b"obj")?;
    // "obj" must follow "N 0"
    let mut q = obj_at;
    while q > 0 && head[q - 1].is_ascii_whitespace() {
        q -= 1;
    }
    if !head[..q].ends_with(b"0") {
        return None;
    }
    q -= 1;
    while q > 0 && head[q - 1].is_ascii_whitespace() {
        q -= 1;
    }
    let num_end = q;
    let mut num_start = num_end;
    while num_start > 0 && head[num_start - 1].is_ascii_digit() {
        num_start -= 1;
    }
    let num: u32 = std::str::from_utf8(&head[num_start..num_end])
        .ok()?
        .parse()
        .ok()?;
    // The dict runs from the first "<<" after "obj" to its balanced ">>".
    let dict_start = find_from(pdf, b"<<", obj_at + 3)?;
    let mut depth = 0usize;
    let mut j = dict_start;
    while j + 1 < stream_at {
        if pdf[j..].starts_with(b"<<") {
            depth += 1;
            j += 2;
        } else if pdf[j..].starts_with(b">>") {
            depth -= 1;
            j += 2;
            if depth == 0 {
                break;
            }
        } else {
            j += 1;
        }
    }
    if depth != 0 || !pdf[j..stream_at].iter().all(|b| b.is_ascii_whitespace()) {
        return None;
    }
    Some((num, dict_start, j))
}

/// End of stream data: trust a direct `/Length` when it lines up with the
/// `endstream` keyword, else fall back to scanning for it.
fn stream_data_end(pdf: &[u8], dict: &[u8], data_start: usize) -> Option<usize> {
    if let Some(len) = direct_length(dict) {
        let cand = data_start.checked_add(len)?;
        let mut e = cand;
        for _ in 0..2 {
            if pdf.get(e) == Some(&b'\r') || pdf.get(e) == Some(&b'\n') {
                e += 1;
            }
        }
        if pdf[e..].starts_with(b"endstream") {
            return Some(cand);
        }
    }
    let q = find_from(pdf, b"endstream", data_start)?;
    let mut end = q;
    while end > data_start && (pdf[end - 1] == b'\n' || pdf[end - 1] == b'\r') {
        end -= 1;
    }
    Some(end)
}

fn direct_length(dict: &[u8]) -> Option<usize> {
    let at = find_from(dict, b"/Length", 0)? + 7;
    let mut i = at;
    while i < dict.len() && dict[i].is_ascii_whitespace() {
        i += 1;
    }
    let start = i;
    while i < dict.len() && dict[i].is_ascii_digit() {
        i += 1;
    }
    if i == start {
        return None; // indirect length
    }
    std::str::from_utf8(&dict[start..i]).ok()?.parse().ok()
}

/// Byte-span of the `trailer` dictionary: the one preceding the final
/// `startxref` (classic xref-table PDFs — cairo's format).
fn trailer_dict(pdf: &[u8]) -> Option<(usize, usize)> {
    let sx = pdf.windows(9).rposition(|w| w == b"startxref")?;
    let t = pdf[..sx].windows(7).rposition(|w| w == b"trailer")? + 7;
    let mut i = t;
    while i < pdf.len() && pdf[i].is_ascii_whitespace() {
        i += 1;
    }
    if !pdf[i..].starts_with(b"<<") {
        return None;
    }
    let mut depth = 0usize;
    let mut j = i;
    while j + 1 < pdf.len() {
        if pdf[j..].starts_with(b"<<") {
            depth += 1;
            j += 2;
        } else if pdf[j..].starts_with(b">>") {
            depth -= 1;
            j += 2;
            if depth == 0 {
                return Some((i, j));
            }
        } else {
            j += 1;
        }
    }
    None
}

fn startxref_value(pdf: &[u8], after: usize) -> Option<u64> {
    let sx = find_from(pdf, b"startxref", after)?;
    let mut i = sx + 9;
    while i < pdf.len() && pdf[i].is_ascii_whitespace() {
        i += 1;
    }
    let start = i;
    while i < pdf.len() && pdf[i].is_ascii_digit() {
        i += 1;
    }
    let v: u64 = std::str::from_utf8(&pdf[start..i]).ok()?.parse().ok()?;
    let mut e = i;
    while e < pdf.len() && pdf[e].is_ascii_whitespace() {
        e += 1;
    }
    (v as usize <= pdf.len() && pdf[v as usize..].starts_with(b"xref")).then_some(v)
}

fn build_object(obj_num: u32, dict: &[u8], data: &[u8], flate: bool) -> Vec<u8> {
    let payload = if flate {
        let mut enc = ZlibEncoder::new(Vec::new(), Compression::new(6));
        enc.write_all(data).ok();
        enc.finish().unwrap_or_default()
    } else {
        data.to_vec()
    };
    let dict = with_length(dict, payload.len());
    let mut out = format!("{obj_num} 0 obj\n").into_bytes();
    out.extend_from_slice(&dict);
    out.extend_from_slice(b"\nstream\n");
    out.extend_from_slice(&payload);
    out.extend_from_slice(b"\nendstream\nendobj\n");
    out
}

/// Replace the `/Length` value (direct or indirect) with `len`.
fn with_length(dict: &[u8], len: usize) -> Vec<u8> {
    let Some(at) = find_from(dict, b"/Length", 0) else {
        let mut d = dict.to_vec();
        let open = d.iter().position(|&b| b == b'<').unwrap_or(0);
        d.splice(open + 1..open + 1, format!("/Length {len} ").into_bytes());
        return d;
    };
    let mut i = at + 7;
    while i < dict.len() && dict[i].is_ascii_whitespace() {
        i += 1;
    }
    let mut end = i;
    // The value is either digits or an indirect "N 0 R"; both are a maximal
    // run of digits/whitespace/'R', bounded by the next key or the dict end.
    while end < dict.len()
        && (dict[end].is_ascii_digit() || dict[end].is_ascii_whitespace() || dict[end] == b'R')
    {
        end += 1;
    }
    let mut d = dict.to_vec();
    d.splice(i..end, format!("{len}").into_bytes());
    d
}

fn find_from(hay: &[u8], needle: &[u8], from: usize) -> Option<usize> {
    if from >= hay.len() || needle.is_empty() {
        return None;
    }
    hay[from..]
        .windows(needle.len())
        .position(|w| w == needle)
        .map(|p| p + from)
}

/// One `beginbf*` entry. Hex strings are kept verbatim so untouched entries
/// round-trip byte-for-byte (including the code width — Type3 subsets use
/// `<xx>`, Type0 `<xxxx>`).
#[derive(Clone)]
enum BfEntry {
    Pair {
        src: Vec<u8>,
        dst: Vec<u8>,
    },
    /// Sequential `<lo> <hi> <base>`; `split` when the run is a well-formed
    /// BMP sequence we may explode around repairable codes.
    Range {
        lo: u32,
        hi: u32,
        base: u32,
        width: usize,
        split: bool,
    },
}

fn hex_units(hex: &[u8]) -> Option<Vec<u16>> {
    if hex.is_empty() || !hex.len().is_multiple_of(4) || !hex.iter().all(|b| b.is_ascii_hexdigit())
    {
        return None;
    }
    Some(
        hex.chunks(4)
            .map(|c| u16::from_str_radix(std::str::from_utf8(c).unwrap(), 16).unwrap())
            .collect(),
    )
}

fn to_hex(units: &[u16]) -> Vec<u8> {
    units
        .iter()
        .flat_map(|u| format!("{u:04X}").into_bytes())
        .collect()
}

/// Rewrite the bf sections of a ToUnicode CMap; `None` when nothing changed.
fn repair_cmap(cmap: &[u8]) -> Option<Vec<u8>> {
    let (start, end, entries) = parse_bf_sections(cmap)?;
    let mut out: Vec<BfEntry> = Vec::with_capacity(entries.len());
    let mut changed = false;
    for e in entries {
        match e {
            BfEntry::Pair { src, dst } => out.push(match repair_dst(&dst) {
                Some(fixed) => {
                    changed = true;
                    BfEntry::Pair { src, dst: fixed }
                }
                None => BfEntry::Pair { src, dst },
            }),
            BfEntry::Range {
                lo,
                hi,
                base,
                width,
                split,
            } => {
                if !split {
                    out.push(BfEntry::Range {
                        lo,
                        hi,
                        base,
                        width,
                        split,
                    });
                    continue;
                }
                let mut run_lo: Option<u32> = None;
                for code in lo..=hi {
                    let dst = to_hex(&[(base + code - lo) as u16]);
                    if let Some(fixed) = repair_dst(&dst) {
                        if let Some(rl) = run_lo.take() {
                            out.push(BfEntry::Range {
                                lo: rl,
                                hi: code - 1,
                                base: base + rl - lo,
                                width,
                                split,
                            });
                        }
                        changed = true;
                        out.push(BfEntry::Pair {
                            src: format!("{code:0width$X}").into_bytes(),
                            dst: fixed,
                        });
                    } else {
                        run_lo.get_or_insert(code);
                    }
                }
                if let Some(rl) = run_lo {
                    out.push(BfEntry::Range {
                        lo: rl,
                        hi,
                        base: base + rl - lo,
                        width,
                        split,
                    });
                }
            }
        }
    }
    if !changed {
        return None;
    }
    let mut result = cmap[..start].to_vec();
    emit_bf_sections(&out, &mut result);
    result.extend_from_slice(&cmap[end..]);
    Some(result)
}

/// Fixed dst hex when `dst` is exactly one BMP char in the radical ranges.
fn repair_dst(dst: &[u8]) -> Option<Vec<u8>> {
    let units = hex_units(dst)?;
    if units.len() != 1 {
        return None; // ligature or astral: no single-char mapping
    }
    let c = char::from_u32(units[0] as u32)?;
    let fixed = unified_equivalent(c)?;
    let mut buf = [0u16; 2];
    Some(to_hex(fixed.encode_utf16(&mut buf)))
}

/// Span (start of the first `beginbf*` keyword, end of the last `endbf*`)
/// plus every entry of every bfchar/bfrange section, in order.
fn parse_bf_sections(cmap: &[u8]) -> Option<(usize, usize, Vec<BfEntry>)> {
    let mut entries = Vec::new();
    let mut span: Option<(usize, usize)> = None;
    let mut i = 0;
    while let Some(kw) = find_from(cmap, b"beginbf", i) {
        let after = kw + 7;
        let (is_range, body_start) = if cmap[after..].starts_with(b"range") {
            (true, after + 5)
        } else if cmap[after..].starts_with(b"char") {
            (false, after + 4)
        } else {
            i = after;
            continue;
        };
        let end_kw: &[u8] = if is_range {
            b"endbfrange"
        } else {
            b"endbfchar"
        };
        let body_end = find_from(cmap, end_kw, body_start)?;
        // Array-form bfranges (`<lo> <hi> [<d>…]`) are not handled; cairo
        // never emits them, so bail out and leave the whole CMap alone.
        if cmap[body_start..body_end].contains(&b'[') {
            return None;
        }
        parse_bf_body(&cmap[body_start..body_end], is_range, &mut entries);
        span = Some(match span {
            Some((s, _)) => (s, body_end + end_kw.len()),
            None => (kw, body_end + end_kw.len()),
        });
        i = body_end + end_kw.len();
    }
    span.map(|(s, e)| (s, e, entries))
}

fn parse_bf_body(body: &[u8], is_range: bool, entries: &mut Vec<BfEntry>) {
    let toks = tokens(body);
    let num = |t: &[u8]| u32::from_str_radix(std::str::from_utf8(t).unwrap(), 16).ok();
    let mut i = 0;
    while i + 1 < toks.len() {
        let (a, b) = (toks[i], toks[i + 1]);
        // Source codes are 1–4 bytes (any even hex width — Type3 subsets
        // use `<xx>`, Type0 `<xxxx>`); destinations are UTF-16BE strings,
        // i.e. whole 2-byte units.
        let src_ok = |t: &[u8]| {
            !t.is_empty()
                && t.len() <= 8
                && t.len().is_multiple_of(2)
                && t.iter().all(|b| b.is_ascii_hexdigit())
        };
        if !src_ok(a) {
            i += 1;
            continue;
        }
        if !is_range && hex_units(b).is_some() {
            entries.push(BfEntry::Pair {
                src: a.to_vec(),
                dst: b.to_vec(),
            });
            i += 2;
        } else if is_range && src_ok(b) && toks.get(i + 2).is_some_and(|t| hex_units(t).is_some()) {
            let c = toks[i + 2];
            let (lo, hi, base) = (
                num(a).unwrap_or(1),
                num(b).unwrap_or(0),
                num(c).unwrap_or(0),
            );
            let split = lo <= hi && hi <= 0xFFFF && base + (hi - lo) <= 0xFFFF && hi - lo < 0x8000;
            entries.push(BfEntry::Range {
                lo,
                hi,
                base,
                width: a.len(),
                split,
            });
            i += 3;
        } else {
            // array-form or malformed: keep the two tokens verbatim so the
            // original bytes survive round-trip.
            entries.push(BfEntry::Pair {
                src: a.to_vec(),
                dst: b.to_vec(),
            });
            i += 1;
        }
    }
}

/// `<hex>` tokens in order; the entry count after `beginbf*` has no angle
/// brackets, so it is skipped naturally.
fn tokens(body: &[u8]) -> Vec<&[u8]> {
    let mut out = Vec::new();
    let mut i = 0;
    while let Some(open) = find_from(body, b"<", i) {
        let Some(close) = find_from(body, b">", open + 1) else {
            break;
        };
        if close - open > 1 && body[open + 1..close].iter().all(|b| b.is_ascii_hexdigit()) {
            out.push(&body[open + 1..close]);
        }
        i = close + 1;
    }
    out
}

/// Re-emit entries as bfchar/bfrange sections of at most 100 entries each
/// (the CMap spec limit), preserving the original entry order.
fn emit_bf_sections(entries: &[BfEntry], out: &mut Vec<u8>) {
    let mut pairs: Vec<(&[u8], &[u8])> = Vec::new();
    let mut ranges: Vec<(u32, u32, u32, usize)> = Vec::new();
    fn flush_pairs(run: &mut Vec<(&[u8], &[u8])>, out: &mut Vec<u8>) {
        for chunk in run.chunks(100) {
            out.extend_from_slice(format!("{} beginbfchar\n", chunk.len()).as_bytes());
            for (s, d) in chunk {
                out.extend_from_slice(b"<");
                out.extend_from_slice(s);
                out.extend_from_slice(b"> <");
                out.extend_from_slice(d);
                out.extend_from_slice(b">\n");
            }
            out.extend_from_slice(b"endbfchar\n");
        }
        run.clear();
    }
    fn flush_ranges(run: &mut Vec<(u32, u32, u32, usize)>, out: &mut Vec<u8>) {
        for chunk in run.chunks(100) {
            out.extend_from_slice(format!("{} beginbfrange\n", chunk.len()).as_bytes());
            for (lo, hi, base, w) in chunk {
                out.extend_from_slice(
                    format!("<{lo:0w$X}> <{hi:0w$X}> <{base:04X}>\n", w = *w).as_bytes(),
                );
            }
            out.extend_from_slice(b"endbfrange\n");
        }
        run.clear();
    }
    for e in entries {
        match e {
            BfEntry::Pair { src, dst } => {
                flush_ranges(&mut ranges, out);
                pairs.push((src, dst));
            }
            BfEntry::Range {
                lo,
                hi,
                base,
                width,
                ..
            } => {
                flush_pairs(&mut pairs, out);
                ranges.push((*lo, *hi, *base, *width));
            }
        }
    }
    flush_pairs(&mut pairs, out);
    flush_ranges(&mut ranges, out);
}

fn has(hay: &[u8], needle: &[u8]) -> bool {
    find_from(hay, needle, 0).is_some()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Minimal classic-xref PDF whose object 5 is the given ToUnicode stream.
    fn stream_object(dict: &str, payload: &[u8]) -> Vec<u8> {
        let mut obj = format!("5 0 obj\n{dict}stream\n").into_bytes();
        obj.extend_from_slice(payload);
        obj.extend_from_slice(b"\nendstream\nendobj\n");
        obj
    }

    fn fixture_pdf(cmap: &str, flate: bool, encrypted: bool) -> Vec<u8> {
        let payload = if flate {
            zlib(cmap.as_bytes())
        } else {
            cmap.as_bytes().to_vec()
        };
        let stream_dict = if flate {
            format!("<< /Filter /FlateDecode /Length {} >> ", payload.len())
        } else {
            format!("<< /Length {} >> ", payload.len())
        };
        let objects: Vec<Vec<u8>> = vec![
            b"<< /Type /Catalog /Pages 2 0 R >>".to_vec(),
            b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>".to_vec(),
            b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 99 99] /Resources << /Font << /F1 4 0 R >> >> >>".to_vec(),
            b"<< /Type /Font /Subtype /Type0 /BaseFont /T /Encoding /Identity-H /DescendantFonts [6 0 R] /ToUnicode 5 0 R >>".to_vec(),
            stream_object(&stream_dict, &payload),
            b"<< /Type /FontDescriptor /FontName /T >>".to_vec(),
        ];
        let mut pdf = b"%PDF-1.4\n".to_vec();
        let mut offsets = vec![0usize]; // object 0 has no offset
        for (i, body) in objects.iter().enumerate() {
            offsets.push(pdf.len());
            if i != 4 {
                // the stream object (index 4, object number 5) already has its header
                pdf.extend_from_slice(format!("{} 0 obj\n", i + 1).as_bytes());
            }
            pdf.extend_from_slice(body);
            if i != 4 {
                pdf.extend_from_slice(b"\nendobj\n");
            }
        }
        let xref_at = pdf.len();
        pdf.extend_from_slice(b"xref\n0 7\n0000000000 65535 f \n");
        for off in &offsets[1..] {
            pdf.extend_from_slice(format!("{off:010} 00000 n \n").as_bytes());
        }
        let enc = if encrypted { " /Encrypt 7 0 R" } else { "" };
        pdf.extend_from_slice(format!("trailer\n<< /Size 7 /Root 1 0 R{enc} >>\n").as_bytes());
        pdf.extend_from_slice(format!("startxref\n{xref_at}\n%%EOF\n").as_bytes());
        pdf
    }

    fn zlib(data: &[u8]) -> Vec<u8> {
        let mut enc = ZlibEncoder::new(Vec::new(), Compression::new(6));
        enc.write_all(data).unwrap();
        enc.finish().unwrap()
    }

    const CMAP_MIX: &str = "/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n\
        /CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def\n\
        /CMapName /Adobe-Identity-UCS def\n/CMapType 2 def\n\
        1 begincodespacerange\n<0000> <FFFF>\nendcodespacerange\n\
        6 beginbfchar\n\
        <0001> <2F42>\n<0002> <2F00>\n<0003> <2F06>\n<0004> <2EDA>\n\
        <0005> <4E2D>\n<0006> <FF21>\n\
        endbfchar\n\
        2 beginbfrange\n\
        <0020> <0022> <0041>\n<0070> <0072> <2EFF>\n\
        endbfrange\n\
        endcmap\nCMapName currentdict /CMap defineresource pop\nend\nend";

    /// Effective src→dst map of the newest ToUnicode for object 5, the way a
    /// PDF text extractor would apply it.
    fn effective_tounicode(pdf: &[u8]) -> std::collections::HashMap<String, String> {
        let streams: Vec<_> = find_cmap_streams(pdf)
            .into_iter()
            .filter(|s| s.obj_num == 5)
            .collect();
        let newest = streams.last().expect("a ToUnicode stream for obj 5");
        let (_, _, entries) = parse_bf_sections(&newest.data).unwrap();
        let mut map = std::collections::HashMap::new();
        for e in &entries {
            match e {
                BfEntry::Pair { src, dst } => {
                    map.insert(
                        String::from_utf8(src.clone()).unwrap(),
                        String::from_utf8(dst.clone()).unwrap(),
                    );
                }
                BfEntry::Range {
                    lo,
                    hi,
                    base,
                    split,
                    ..
                } if *split => {
                    for code in *lo..=*hi {
                        map.insert(format!("{code:04X}"), format!("{:04X}", base + code - lo));
                    }
                }
                BfEntry::Range { .. } => unreachable!("fixture has no unsplit ranges"),
            }
        }
        map
    }

    #[test]
    fn unified_equivalent_matches_unicode_data() {
        // NFKC path (the whole Kangxi block decomposes).
        assert_eq!(unified_equivalent('\u{2F00}'), Some('\u{4E00}')); // ⼀→一
        assert_eq!(unified_equivalent('\u{2F06}'), Some('\u{4E8C}')); // ⼆→二
        assert_eq!(unified_equivalent('\u{2F42}'), Some('\u{6587}')); // ⽂→文
        assert_eq!(unified_equivalent('\u{2F8C}'), Some('\u{864D}')); // 虍 radical → 虍 ideograph
        // Glyph-sharing table path (no NFKC decomposition exists).
        assert_eq!(unified_equivalent('\u{2EDA}'), Some('\u{9875}')); // ⻚→页
        assert_eq!(unified_equivalent('\u{2EC1}'), Some('\u{864E}')); // ⻁→虎
        assert_eq!(unified_equivalent('\u{2EA0}'), Some('\u{6C11}')); // ⺠→民
        assert_eq!(unified_equivalent('\u{2E9E}'), Some('\u{6B7A}')); // ⺞→殺 shape
        // Outside the two blocks, or without any equivalent: untouched.
        assert_eq!(unified_equivalent('\u{4E2D}'), None);
        assert_eq!(unified_equivalent('\u{FF21}'), None);
        assert_eq!(unified_equivalent('\u{2E80}'), None); // no NFKC, no shared glyph
        assert_eq!(unified_equivalent('\u{2EFF}'), None);
    }

    #[test]
    fn repairs_raw_and_flate_streams() {
        for flate in [false, true] {
            let pdf = fixture_pdf(CMAP_MIX, flate, false);
            let fixed = repair_radical_tounicode(&pdf).unwrap_or_else(|| {
                panic!("no repair for flate={flate}");
            });
            let map = effective_tounicode(&fixed);
            assert_eq!(map["0001"], "6587", "文 flate={flate}");
            assert_eq!(map["0002"], "4E00", "一 flate={flate}");
            assert_eq!(map["0003"], "4E8C", "二 flate={flate}");
            assert_eq!(map["0004"], "9875", "页 flate={flate}");
            // Untouched destinations keep their codepoints.
            assert_eq!(map["0005"], "4E2D", "中 flate={flate}");
            assert_eq!(map["0006"], "FF21", "full-width A flate={flate}");
            // A bfrange with no radicals inside stays a compact range.
            assert_eq!(map["0020"], "0041");
            assert_eq!(map["0022"], "0043");
            // Mixed range: 2EFF stays, the radical codes around it are split out.
            assert_eq!(map["0070"], "2EFF");
            assert_eq!(map["0071"], "4E00");
            assert_eq!(map["0072"], "4E28");
            // The original object bytes are still there (incremental update).
            assert!(fixed.starts_with(&pdf[..pdf.len() - 1]) || fixed.starts_with(&pdf));
        }
    }

    #[test]
    fn type3_two_digit_codes_round_trip() {
        // Byte-for-byte the shape cairo emits for Type3 subsets (#166 repro).
        let cmap = "/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n\
            /CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def\n\
            /CMapName /Adobe-Identity-UCS def\n/CMapType 2 def\n\
            1 begincodespacerange\n<00> <FF>\nendcodespacerange\n\
            2 beginbfchar\n<4C> <2F00>\n<8A> <4E2D>\nendbfchar\n\
            endcmap\nCMapName currentdict /CMap defineresource pop\nend\nend";
        let pdf = fixture_pdf(cmap, true, false);
        let fixed = repair_radical_tounicode(&pdf).expect("repair");
        let map = effective_tounicode(&fixed);
        assert_eq!(map["4C"], "4E00");
        assert_eq!(map["8A"], "4E2D");
    }

    #[test]
    fn no_radicals_leaves_pdf_untouched() {
        let cmap = CMAP_MIX
            .replace(
                "<0001> <2F42>\n<0002> <2F00>\n<0003> <2F06>\n<0004> <2EDA>\n",
                "<0001> <6587>\n<0002> <4E00>\n<0003> <4E8C>\n<0004> <9875>\n",
            )
            .replace("<0070> <0072> <2EFF>", "<0070> <0072> <0058>");
        let pdf = fixture_pdf(&cmap, false, false);
        assert!(repair_radical_tounicode(&pdf).is_none());
    }

    #[test]
    fn ligature_and_astral_destinations_untouched() {
        // Multi-unit destinations have no single-char mapping.
        let cmap = CMAP_MIX
            .replace(
                "<0001> <2F42>\n<0002> <2F00>\n<0003> <2F06>\n<0004> <2EDA>\n\
             <0005> <4E2D>\n<0006> <FF21>",
                "<0001> <00660066>\n<0002> <D84CDFD8>\n<0003> <4E2D>\n<0004> <FF21>\n\
             <0005> <00C4>\n<0006> <2026>",
            )
            .replace("<0070> <0072> <2EFF>", "<0070> <0072> <0058>");
        let pdf = fixture_pdf(&cmap, false, false);
        assert!(repair_radical_tounicode(&pdf).is_none());
    }

    #[test]
    fn incremental_update_structure_is_valid() {
        let pdf = fixture_pdf(CMAP_MIX, true, false);
        let old_xref = startxref_value(&pdf, trailer_dict(&pdf).unwrap().1).unwrap();
        let fixed = repair_radical_tounicode(&pdf).unwrap();
        assert!(fixed.ends_with(b"%%EOF\n"));
        assert!(fixed.starts_with(&pdf[..pdf.len()]));

        // The new trailer chains to the old xref via /Prev and keeps /Size.
        let (ts, te) = trailer_dict(&fixed).unwrap();
        let trailer = std::str::from_utf8(&fixed[ts..te]).unwrap();
        assert!(trailer.contains("/Size 7"));
        assert!(trailer.contains(&format!("/Prev {old_xref}")));
        assert!(trailer.contains("/Root 1 0 R"));

        // Every xref entry in the update points at a real object header.
        let new_xref = startxref_value(&fixed, te).unwrap() as usize;
        assert!(fixed[new_xref..].starts_with(b"xref\n"));
        let body = &fixed[new_xref..te.min(fixed.len())];
        let text = std::str::from_utf8(body).unwrap();
        for line in text.lines().skip(1) {
            let mut it = line.split_whitespace();
            if let (Some(off), Some(_gen), Some("n")) = (it.next(), it.next(), it.next()) {
                let at: usize = off.parse().unwrap();
                let rest = &fixed[at..];
                let sp = rest.iter().position(|&b| b == b' ').unwrap();
                let obj_num: u32 = std::str::from_utf8(&rest[..sp]).unwrap().parse().unwrap();
                assert!(rest.starts_with(format!("{obj_num} 0 obj").as_bytes()));
            }
        }
    }

    #[test]
    fn encrypted_and_xref_stream_pdfs_are_left_alone() {
        let encrypted = fixture_pdf(CMAP_MIX, false, true);
        assert!(repair_radical_tounicode(&encrypted).is_none());

        let mut no_trailer = fixture_pdf(CMAP_MIX, false, false);
        let cut = no_trailer
            .windows(7)
            .rposition(|w| w == b"trailer")
            .unwrap();
        no_trailer.drain(cut..cut + 7); // xref-stream-shaped file
        assert!(repair_radical_tounicode(&no_trailer).is_none());
    }
}
