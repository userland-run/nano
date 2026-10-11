// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-UEL
// Copyright (C) 2026 And The Next GmbH - https://userland.run
//
// `exifstrip` for the nano wasm runner (runners/wasm), compiled to wasm32-wasip1.
//
// Lossless photo-metadata removal: only metadata containers are dropped (JPEG
// APPn/COM segments, PNG text/eXIf/tIME chunks, WebP EXIF/XMP chunks); the
// compressed pixel data is copied byte-for-byte, never decoded or re-encoded.
// HEIF/HEIC/AVIF: the Exif and XMP items are blanked IN PLACE (same length, so
// no box offsets move) — GPS/camera/date are gone, pixel data untouched.
//
//   exifstrip strip [--keep-orientation] [--keep-icc] [-o OUTDIR] FILES|DIRS...
//   exifstrip show FILES|DIRS...
//
// Exit codes: 0 ok, 1 at least one file failed (unsupported/corrupt/io), 2 usage.
// Single-threaded, no dependencies; stdout is deterministic (goldens).

use std::fmt::Write as _;
use std::fs;
use std::path::{Component, Path, PathBuf};
use std::process::ExitCode;

const VERSION: &str = env!("CARGO_PKG_VERSION");

const USAGE: &str = "\
exifstrip - remove photo metadata (EXIF/GPS, XMP, IPTC, comments) losslessly

Usage:
  exifstrip strip [--keep-orientation] [--keep-icc] [-o OUTDIR] FILES|DIRS...
  exifstrip show FILES|DIRS...

strip   Remove metadata. In place by default; with -o, write copies to OUTDIR
        (a file lands at OUTDIR/<name>, a directory at OUTDIR/<dir>/<rel path>).
        Directories are processed recursively (dot-entries are skipped).
        Pixel data is never re-encoded: only metadata blocks are removed.
  --keep-orientation  keep the EXIF Orientation tag (minimal EXIF block)
  --keep-icc          keep the embedded ICC color profile
show    Print a summary of the metadata found (GPS, camera, date, ...).

Formats: JPEG, PNG, WebP, HEIF/HEIC/AVIF (Exif/XMP blanked in place).
Exit codes: 0 ok, 1 some file failed, 2 usage error.
";

// ---------------------------------------------------------------- formats

#[derive(Clone, Copy, PartialEq, Debug)]
enum Kind {
    Jpeg,
    Png,
    Webp,
    Heif,
}

fn detect(b: &[u8]) -> Option<Kind> {
    if b.len() >= 3 && b[0] == 0xFF && b[1] == 0xD8 && b[2] == 0xFF {
        return Some(Kind::Jpeg);
    }
    if b.len() >= 8 && b[..8] == [0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A] {
        return Some(Kind::Png);
    }
    if b.len() >= 12 && &b[0..4] == b"RIFF" && &b[8..12] == b"WEBP" {
        return Some(Kind::Webp);
    }
    if b.len() >= 12 && &b[4..8] == b"ftyp" {
        let brand = &b[8..12];
        const BRANDS: [&[u8; 4]; 9] = [b"heic", b"heix", b"heim", b"heis", b"hevc", b"hevx", b"mif1", b"msf1", b"avif"];
        if BRANDS.iter().any(|x| &x[..] == brand) {
            return Some(Kind::Heif);
        }
    }
    None
}

fn be16(b: &[u8], i: usize) -> Option<u16> {
    Some(u16::from_be_bytes(b.get(i..i + 2)?.try_into().ok()?))
}
fn be32(b: &[u8], i: usize) -> Option<u32> {
    Some(u32::from_be_bytes(b.get(i..i + 4)?.try_into().ok()?))
}
fn be64(b: &[u8], i: usize) -> Option<u64> {
    Some(u64::from_be_bytes(b.get(i..i + 8)?.try_into().ok()?))
}
fn le32(b: &[u8], i: usize) -> Option<u32> {
    Some(u32::from_le_bytes(b.get(i..i + 4)?.try_into().ok()?))
}

/// What a file carries; filled by each format's scanner.
#[derive(Default)]
struct Meta {
    format: String,
    dims: Option<(u32, u32)>,
    exif: Option<Vec<u8>>, // raw TIFF block (starting at "II"/"MM")
    exif_bytes: usize,
    xmp_bytes: usize,
    icc_bytes: usize,
    other: Vec<String>, // other metadata blocks (comment, iptc, text:key, ...)
}

/// Result of stripping: new bytes + labels of what was removed.
struct Stripped {
    out: Vec<u8>,
    removed: Vec<String>,
}

fn push_label(v: &mut Vec<String>, s: &str) {
    if !v.iter().any(|x| x == s) {
        v.push(s.to_string());
    }
    // Canonical order so the report does not depend on block order in the file.
    const ORDER: [&str; 13] = ["exif", "gps", "xmp", "icc", "iptc", "comment", "text", "time", "mpf", "mpf-images", "app1", "app2", "appn"];
    v.sort_by_key(|x| ORDER.iter().position(|o| o == x).unwrap_or(ORDER.len()));
}

// ------------------------------------------------------------ TIFF / EXIF

#[derive(Default)]
struct ExifInfo {
    make: Option<String>,
    model: Option<String>,
    date: Option<String>,
    orientation: Option<u16>,
    gps: bool,
    gps_pos: Option<(f64, f64)>,
    tags: usize,
    thumbnail: bool,
}

struct Tiff<'a> {
    b: &'a [u8],
    le: bool,
}

impl<'a> Tiff<'a> {
    fn new(b: &'a [u8]) -> Option<Self> {
        let le = match b.get(0..4)? {
            [b'I', b'I', 42, 0] => true,
            [b'M', b'M', 0, 42] => false,
            _ => return None,
        };
        Some(Tiff { b, le })
    }
    fn u16(&self, i: usize) -> Option<u16> {
        let s: [u8; 2] = self.b.get(i..i + 2)?.try_into().ok()?;
        Some(if self.le { u16::from_le_bytes(s) } else { u16::from_be_bytes(s) })
    }
    fn u32(&self, i: usize) -> Option<u32> {
        let s: [u8; 4] = self.b.get(i..i + 4)?.try_into().ok()?;
        Some(if self.le { u32::from_le_bytes(s) } else { u32::from_be_bytes(s) })
    }
    /// Entries of the IFD at `off`: (tag, type, count, data offset) + next-IFD offset.
    fn ifd(&self, off: usize) -> Option<(Vec<(u16, u16, u32, usize)>, u32)> {
        let n = self.u16(off)? as usize;
        if n > 1000 {
            return None;
        }
        let mut v = Vec::with_capacity(n);
        for k in 0..n {
            let e = off + 2 + k * 12;
            let (tag, typ, cnt) = (self.u16(e)?, self.u16(e + 2)?, self.u32(e + 4)?);
            let unit = match typ {
                1 | 2 | 6 | 7 => 1usize,
                3 | 8 => 2,
                4 | 9 | 11 => 4,
                5 | 10 | 12 => 8,
                _ => 0,
            };
            let size = unit.saturating_mul(cnt as usize);
            let data = if size <= 4 { e + 8 } else { self.u32(e + 8)? as usize };
            v.push((tag, typ, cnt, data));
        }
        let next = self.u32(off + 2 + n * 12).unwrap_or(0);
        Some((v, next))
    }
    fn ascii(&self, data: usize, cnt: u32) -> Option<String> {
        let raw = self.b.get(data..data.checked_add(cnt as usize)?)?;
        let s: String = raw
            .iter()
            .take_while(|&&c| c != 0)
            .map(|&c| if (0x20..0x7f).contains(&c) { c as char } else { '?' })
            .collect();
        let s = s.trim().to_string();
        if s.is_empty() { None } else { Some(s) }
    }
    fn short(&self, typ: u16, data: usize) -> Option<u16> {
        match typ {
            3 => self.u16(data),
            4 => self.u32(data).map(|v| v as u16),
            _ => None,
        }
    }
    fn rationals3(&self, data: usize) -> Option<f64> {
        let mut deg = 0.0;
        for (k, div) in [1.0, 60.0, 3600.0].iter().enumerate() {
            let (n, d) = (self.u32(data + k * 8)? as f64, self.u32(data + k * 8 + 4)? as f64);
            if d == 0.0 {
                if n == 0.0 { continue } else { return None }
            }
            deg += n / d / div;
        }
        Some(deg)
    }
}

fn parse_exif(tiff: &[u8]) -> ExifInfo {
    let mut info = ExifInfo::default();
    let Some(t) = Tiff::new(tiff) else { return info };
    let Some(ifd0_off) = t.u32(4) else { return info };
    let Some((ifd0, next)) = t.ifd(ifd0_off as usize) else { return info };
    info.tags += ifd0.len();
    info.thumbnail = next != 0;
    let mut date = None;
    for &(tag, typ, cnt, data) in &ifd0 {
        match tag {
            0x010F => info.make = t.ascii(data, cnt),
            0x0110 => info.model = t.ascii(data, cnt),
            0x0132 => date = t.ascii(data, cnt),
            0x0112 => info.orientation = t.short(typ, data),
            0x8769 => {
                if let Some(off) = t.u32(data) {
                    if let Some((sub, _)) = t.ifd(off as usize) {
                        info.tags += sub.len();
                        for &(tag, _, cnt, data) in &sub {
                            if tag == 0x9003 {
                                info.date = t.ascii(data, cnt);
                            }
                        }
                    }
                }
            }
            0x8825 => {
                if let Some(off) = t.u32(data) {
                    if let Some((gps, _)) = t.ifd(off as usize) {
                        info.tags += gps.len();
                        info.gps = !gps.is_empty();
                        let (mut lat, mut lon, mut lat_ref, mut lon_ref) = (None, None, b'N', b'E');
                        for &(tag, typ, cnt, data) in &gps {
                            match (tag, typ) {
                                (1, 2) => lat_ref = t.b.get(data).copied().unwrap_or(b'N'),
                                (3, 2) => lon_ref = t.b.get(data).copied().unwrap_or(b'E'),
                                (2, 5) if cnt >= 3 => lat = t.rationals3(data),
                                (4, 5) if cnt >= 3 => lon = t.rationals3(data),
                                _ => {}
                            }
                        }
                        if let (Some(a), Some(o)) = (lat, lon) {
                            let a = if lat_ref == b'S' { -a } else { a };
                            let o = if lon_ref == b'W' { -o } else { o };
                            info.gps_pos = Some((a, o));
                        }
                    }
                }
            }
            _ => {}
        }
    }
    if info.date.is_none() {
        info.date = date;
    }
    info
}

/// A minimal little-endian TIFF block: IFD0 with only Orientation (or empty).
fn minimal_tiff(orientation: Option<u16>) -> Vec<u8> {
    let mut v = b"II*\0\x08\0\0\0".to_vec();
    match orientation {
        Some(o) => {
            v.extend_from_slice(&1u16.to_le_bytes());
            v.extend_from_slice(&0x0112u16.to_le_bytes());
            v.extend_from_slice(&3u16.to_le_bytes());
            v.extend_from_slice(&1u32.to_le_bytes());
            v.extend_from_slice(&o.to_le_bytes());
            v.extend_from_slice(&[0, 0]);
        }
        None => v.extend_from_slice(&0u16.to_le_bytes()),
    }
    v.extend_from_slice(&0u32.to_le_bytes());
    v
}

fn orientation_of(tiff: Option<&[u8]>) -> Option<u16> {
    tiff.and_then(|t| parse_exif(t).orientation).filter(|o| (1..=8).contains(o))
}

// ------------------------------------------------------------------ JPEG

const EXIF_HDR: &[u8] = b"Exif\0\0";
const XMP_HDR: &[u8] = b"http://ns.adobe.com/xap/1.0/\0";
const XMP_EXT_HDR: &[u8] = b"http://ns.adobe.com/xmp/extension/\0";
const ICC_HDR: &[u8] = b"ICC_PROFILE\0";

/// One JPEG piece: a marker segment (marker != 0) or entropy-coded data (marker 0).
struct JSeg {
    marker: u8,
    start: usize,
    end: usize,
}

/// Walk a JPEG into segments; returns (segments after SOI, offset just past EOI).
fn jpeg_segments(b: &[u8]) -> Result<(Vec<JSeg>, usize), String> {
    let mut segs = Vec::new();
    let mut i = 2;
    loop {
        if i >= b.len() {
            return Ok((segs, b.len())); // missing EOI: tolerate truncated tail
        }
        if b[i] != 0xFF {
            return Err(format!("corrupt JPEG (expected marker at offset {i})"));
        }
        while i + 1 < b.len() && b[i + 1] == 0xFF {
            i += 1; // fill bytes
        }
        let m = *b.get(i + 1).ok_or("truncated JPEG")?;
        if m == 0xD9 {
            segs.push(JSeg { marker: m, start: i, end: i + 2 });
            return Ok((segs, i + 2));
        }
        if (0xD0..=0xD7).contains(&m) || m == 0x01 {
            segs.push(JSeg { marker: m, start: i, end: i + 2 });
            i += 2;
            continue;
        }
        let len = be16(b, i + 2).ok_or("truncated JPEG segment")? as usize;
        let end = i + 2 + len;
        if len < 2 || end > b.len() {
            return Err(format!("corrupt JPEG segment at offset {i}"));
        }
        segs.push(JSeg { marker: m, start: i, end });
        i = end;
        if m == 0xDA {
            let mut j = i;
            while j + 1 < b.len() {
                if b[j] == 0xFF {
                    let n = b[j + 1];
                    if n == 0x00 || (0xD0..=0xD7).contains(&n) {
                        j += 2;
                        continue;
                    }
                    if n == 0xFF {
                        j += 1;
                        continue;
                    }
                    break;
                }
                j += 1;
            }
            if j + 1 >= b.len() {
                j = b.len();
            }
            segs.push(JSeg { marker: 0, start: i, end: j });
            i = j;
        }
    }
}

/// Classify a JPEG segment: Some(label) for metadata, None for image data/tables.
fn jpeg_meta_label(m: u8, p: &[u8]) -> Option<&'static str> {
    match m {
        0xE1 if p.starts_with(EXIF_HDR) => Some("exif"),
        0xE1 if p.starts_with(XMP_HDR) || p.starts_with(XMP_EXT_HDR) => Some("xmp"),
        0xE1 => Some("app1"),
        0xE2 if p.starts_with(ICC_HDR) => Some("icc"),
        0xE2 if p.starts_with(b"MPF\0") => Some("mpf"),
        0xE2 => Some("app2"),
        0xE3..=0xEC | 0xEF => Some("appn"),
        0xED => Some("iptc"),
        0xFE => Some("comment"),
        _ => None, // APP0 (JFIF), APP14 (Adobe color transform), tables, SOF, SOS, ...
    }
}

fn jpeg_scan(b: &[u8]) -> Result<Meta, String> {
    let (segs, eoi) = jpeg_segments(b)?;
    let mut m = Meta { format: "JPEG".into(), ..Default::default() };
    for s in &segs {
        if s.marker == 0 || s.end - s.start < 4 {
            continue;
        }
        let p = &b[s.start + 4..s.end];
        if matches!(s.marker, 0xC0..=0xCF) && !matches!(s.marker, 0xC4 | 0xC8 | 0xCC) && m.dims.is_none() {
            if let (Some(h), Some(w)) = (be16(p, 1), be16(p, 3)) {
                m.dims = Some((w as u32, h as u32));
            }
        }
        match jpeg_meta_label(s.marker, p) {
            Some("exif") => {
                m.exif_bytes += p.len();
                if m.exif.is_none() {
                    m.exif = Some(p[EXIF_HDR.len()..].to_vec());
                }
            }
            Some("xmp") => m.xmp_bytes += p.len(),
            Some("icc") => m.icc_bytes += p.len().saturating_sub(ICC_HDR.len() + 2),
            Some(l) => push_label(&mut m.other, l),
            None => {}
        }
    }
    if eoi < b.len() {
        push_label(&mut m.other, &format!("trailer({}B)", b.len() - eoi));
    }
    Ok(m)
}

fn jpeg_strip(b: &[u8], keep_orientation: bool, keep_icc: bool) -> Result<Stripped, String> {
    let (segs, eoi) = jpeg_segments(b)?;
    let mut removed = Vec::new();
    let mut out = Vec::with_capacity(b.len());
    out.extend_from_slice(&b[..2]);
    let mut orientation = None;
    let mut mpf = false;
    for s in &segs {
        if s.marker != 0 && s.end - s.start >= 4 {
            let p = &b[s.start + 4..s.end];
            if let Some(l) = jpeg_meta_label(s.marker, p) {
                if l == "icc" && keep_icc {
                    // kept below
                } else {
                    if l == "exif" && orientation.is_none() {
                        orientation = orientation_of(Some(&p[EXIF_HDR.len()..]));
                    }
                    if l == "exif" && parse_exif(&p[EXIF_HDR.len()..]).gps {
                        push_label(&mut removed, "gps");
                    }
                    if l == "mpf" {
                        mpf = true;
                    }
                    push_label(&mut removed, l);
                    continue;
                }
            }
        }
        out.extend_from_slice(&b[s.start..s.end]);
    }
    // Data after EOI: MPF secondary images (previews/depth maps, each with its own
    // EXIF) are dropped with the MPF index; any other trailer is kept as-is.
    if eoi < b.len() {
        if mpf {
            push_label(&mut removed, "mpf-images");
        } else {
            out.extend_from_slice(&b[eoi..]);
        }
    }
    if keep_orientation {
        if let Some(o) = orientation {
            let mut seg = vec![0xFF, 0xE1, 0, 0];
            seg.extend_from_slice(EXIF_HDR);
            seg.extend_from_slice(&minimal_tiff(Some(o)));
            let len = (seg.len() - 2) as u16;
            seg[2..4].copy_from_slice(&len.to_be_bytes());
            // After SOI (and after APP0/JFIF if present, which must come first).
            let at = if out.len() >= 4 && out[2] == 0xFF && out[3] == 0xE0 {
                2 + 2 + be16(&out, 4).unwrap_or(0) as usize
            } else {
                2
            };
            out.splice(at..at, seg);
        }
    }
    Ok(Stripped { out, removed })
}

// ------------------------------------------------------------------- PNG

fn crc32(data: &[u8]) -> u32 {
    let mut c = 0xFFFF_FFFFu32;
    for &x in data {
        c ^= x as u32;
        for _ in 0..8 {
            c = if c & 1 != 0 { 0xEDB8_8320 ^ (c >> 1) } else { c >> 1 };
        }
    }
    !c
}

/// PNG chunks: (type, chunk start, data start, data end, chunk end).
fn png_chunks(b: &[u8]) -> Result<Vec<([u8; 4], usize, usize, usize, usize)>, String> {
    let mut v = Vec::new();
    let mut i = 8;
    while i < b.len() {
        let len = be32(b, i).ok_or("truncated PNG chunk")? as usize;
        let typ: [u8; 4] = b.get(i + 4..i + 8).ok_or("truncated PNG chunk")?.try_into().unwrap();
        let end = i.checked_add(12 + len).ok_or("corrupt PNG")?;
        if end > b.len() {
            return Err(format!("corrupt PNG chunk at offset {i}"));
        }
        v.push((typ, i, i + 8, i + 8 + len, end));
        i = end;
        if &typ == b"IEND" {
            break;
        }
    }
    Ok(v)
}

fn png_text_key(data: &[u8]) -> String {
    let k: String = data.iter().take_while(|&&c| c != 0).take(79).map(|&c| c as char).collect();
    k
}

fn png_label(typ: &[u8; 4], data: &[u8]) -> Option<String> {
    match typ {
        b"eXIf" => Some("exif".into()),
        b"iCCP" => Some("icc".into()),
        b"tIME" => Some("time".into()),
        b"tEXt" | b"zTXt" | b"iTXt" => {
            let k = png_text_key(data);
            Some(if k == "XML:com.adobe.xmp" {
                "xmp".into()
            } else if k.starts_with("Raw profile type exif") || k.starts_with("Raw profile type APP1") {
                "exif".into()
            } else {
                format!("text:{k}")
            })
        }
        _ => None,
    }
}

fn png_scan(b: &[u8]) -> Result<Meta, String> {
    let mut m = Meta { format: "PNG".into(), ..Default::default() };
    for (typ, _, ds, de, _) in png_chunks(b)? {
        let d = &b[ds..de];
        if &typ == b"IHDR" {
            if let (Some(w), Some(h)) = (be32(d, 0), be32(d, 4)) {
                m.dims = Some((w, h));
            }
        }
        match png_label(&typ, d).as_deref() {
            Some("exif") => {
                m.exif_bytes += d.len();
                if &typ == b"eXIf" && m.exif.is_none() {
                    m.exif = Some(d.to_vec());
                }
            }
            Some("xmp") => m.xmp_bytes += d.len(),
            Some("icc") => m.icc_bytes += d.len(),
            Some(l) => push_label(&mut m.other, l),
            None => {}
        }
    }
    Ok(m)
}

fn png_strip(b: &[u8], keep_orientation: bool, keep_icc: bool) -> Result<Stripped, String> {
    let chunks = png_chunks(b)?;
    let mut removed = Vec::new();
    let mut out = b[..8].to_vec();
    let mut orientation = None;
    let mut inserted = false;
    for (typ, cs, ds, de, ce) in &chunks {
        let d = &b[*ds..*de];
        if let Some(l) = png_label(typ, d) {
            if !(l == "icc" && keep_icc) {
                if typ == b"eXIf" {
                    orientation = orientation.or(orientation_of(Some(d)));
                    if parse_exif(d).gps {
                        push_label(&mut removed, "gps");
                    }
                }
                push_label(&mut removed, if l.starts_with("text:") { "text" } else { &l });
                continue;
            }
        }
        if typ == b"IDAT" && keep_orientation && !inserted {
            inserted = true;
            if let Some(o) = orientation {
                let tiff = minimal_tiff(Some(o));
                out.extend_from_slice(&(tiff.len() as u32).to_be_bytes());
                let mut td = b"eXIf".to_vec();
                td.extend_from_slice(&tiff);
                out.extend_from_slice(&td);
                out.extend_from_slice(&crc32(&td).to_be_bytes());
            }
        }
        out.extend_from_slice(&b[*cs..*ce]);
    }
    if let Some(&(_, _, _, _, ce)) = chunks.last() {
        out.extend_from_slice(&b[ce..]); // bytes after IEND (rare) are kept
    }
    Ok(Stripped { out, removed })
}

// ------------------------------------------------------------------ WebP

/// RIFF chunks: (fourcc, chunk start, data start, data end, chunk end incl. pad).
fn webp_chunks(b: &[u8]) -> Result<Vec<([u8; 4], usize, usize, usize, usize)>, String> {
    let riff_end = (le32(b, 4).ok_or("truncated WebP")? as usize).saturating_add(8).min(b.len());
    let mut v = Vec::new();
    let mut i = 12;
    while i + 8 <= riff_end {
        let typ: [u8; 4] = b[i..i + 4].try_into().unwrap();
        let len = le32(b, i + 4).unwrap() as usize;
        let de = (i + 8).checked_add(len).ok_or("corrupt WebP")?;
        if de > b.len() {
            return Err(format!("corrupt WebP chunk at offset {i}"));
        }
        let ce = (de + (len & 1)).min(b.len());
        v.push((typ, i, i + 8, de, ce));
        i = ce;
    }
    Ok(v)
}

fn webp_label(typ: &[u8; 4]) -> Option<&'static str> {
    match typ {
        b"EXIF" => Some("exif"),
        b"XMP " => Some("xmp"),
        b"ICCP" => Some("icc"),
        _ => None,
    }
}

fn webp_scan(b: &[u8]) -> Result<Meta, String> {
    let mut m = Meta { format: "WebP".into(), ..Default::default() };
    for (typ, _, ds, de, _) in webp_chunks(b)? {
        let d = &b[ds..de];
        match &typ {
            b"VP8X" if d.len() >= 10 => {
                let w = 1 + (d[4] as u32 | (d[5] as u32) << 8 | (d[6] as u32) << 16);
                let h = 1 + (d[7] as u32 | (d[8] as u32) << 8 | (d[9] as u32) << 16);
                m.dims = Some((w, h));
            }
            b"VP8 " if d.len() >= 10 && m.dims.is_none() => {
                let w = u16::from_le_bytes([d[6], d[7]]) as u32 & 0x3FFF;
                let h = u16::from_le_bytes([d[8], d[9]]) as u32 & 0x3FFF;
                m.dims = Some((w, h));
            }
            b"VP8L" if d.len() >= 5 && m.dims.is_none() => {
                let bits = u32::from_le_bytes([d[1], d[2], d[3], d[4]]);
                m.dims = Some(((bits & 0x3FFF) + 1, ((bits >> 14) & 0x3FFF) + 1));
            }
            _ => {}
        }
        match webp_label(&typ) {
            Some("exif") => {
                m.exif_bytes += d.len();
                if m.exif.is_none() {
                    // Some writers prefix the TIFF block with "Exif\0\0".
                    let t = if d.starts_with(EXIF_HDR) { &d[EXIF_HDR.len()..] } else { d };
                    m.exif = Some(t.to_vec());
                }
            }
            Some("xmp") => m.xmp_bytes += d.len(),
            Some("icc") => m.icc_bytes += d.len(),
            _ => {}
        }
    }
    Ok(m)
}

fn webp_strip(b: &[u8], keep_orientation: bool, keep_icc: bool) -> Result<Stripped, String> {
    let chunks = webp_chunks(b)?;
    let mut removed = Vec::new();
    let mut out = b[..12].to_vec();
    let mut orientation = None;
    let mut vp8x_at = None;
    let (mut has_icc, mut has_exif) = (false, false);
    for (typ, cs, ds, de, ce) in &chunks {
        let d = &b[*ds..*de];
        if let Some(l) = webp_label(typ) {
            if l == "icc" && keep_icc {
                has_icc = true;
            } else {
                if l == "exif" {
                    let t = if d.starts_with(EXIF_HDR) { &d[EXIF_HDR.len()..] } else { d };
                    orientation = orientation.or(orientation_of(Some(t)));
                    if parse_exif(t).gps {
                        push_label(&mut removed, "gps");
                    }
                }
                push_label(&mut removed, l);
                continue;
            }
        }
        if typ == b"VP8X" {
            vp8x_at = Some(out.len());
        }
        out.extend_from_slice(&b[*cs..*ce]);
    }
    if keep_orientation && vp8x_at.is_some() {
        if let Some(o) = orientation {
            let tiff = minimal_tiff(Some(o));
            out.extend_from_slice(b"EXIF");
            out.extend_from_slice(&(tiff.len() as u32).to_le_bytes());
            out.extend_from_slice(&tiff);
            if tiff.len() & 1 == 1 {
                out.push(0);
            }
            has_exif = true;
        }
    }
    if let Some(at) = vp8x_at {
        // VP8X flags: ICC 0x20, EXIF 0x08, XMP 0x04 — clear what is gone.
        let f = &mut out[at + 8];
        *f &= !(0x20 | 0x08 | 0x04);
        if has_icc {
            *f |= 0x20;
        }
        if has_exif {
            *f |= 0x08;
        }
    }
    let riff = (out.len() - 8) as u32;
    out[4..8].copy_from_slice(&riff.to_le_bytes());
    Ok(Stripped { out, removed })
}

// ------------------------------------------------------------- HEIF/AVIF

/// ISO-BMFF boxes in b[start..end]: (type, box start, payload start, box end).
fn bmff_boxes(b: &[u8], start: usize, end: usize) -> Result<Vec<([u8; 4], usize, usize, usize)>, String> {
    let mut v = Vec::new();
    let mut i = start;
    while i + 8 <= end {
        let size32 = be32(b, i).unwrap() as usize;
        let typ: [u8; 4] = b[i + 4..i + 8].try_into().unwrap();
        let (hdr, size) = match size32 {
            0 => (8, end - i),
            1 => (16, be64(b, i + 8).ok_or("truncated box")? as usize),
            n => (8, n),
        };
        let be = i.checked_add(size).ok_or("corrupt box")?;
        if size < hdr || be > end {
            return Err(format!("corrupt HEIF box at offset {i}"));
        }
        v.push((typ, i, i + hdr, be));
        i = be;
    }
    Ok(v)
}

fn read_n(b: &[u8], i: usize, n: usize) -> Option<u64> {
    match n {
        0 => Some(0),
        4 => be32(b, i).map(|x| x as u64),
        8 => be64(b, i),
        2 => be16(b, i).map(|x| x as u64),
        _ => None,
    }
}

struct HeifItems {
    /// item id → (item_type, content_type)
    items: Vec<(u32, [u8; 4], String)>,
    /// item id → absolute file extents (offset, length)
    locs: Vec<(u32, Vec<(usize, usize)>)>,
    dims: Option<(u32, u32)>,
    icc: usize,
    brand: String,
}

fn heif_parse(b: &[u8]) -> Result<HeifItems, String> {
    let top = bmff_boxes(b, 0, b.len())?;
    let brand = String::from_utf8_lossy(&b[8..12]).to_string();
    let meta = top.iter().find(|x| &x.0 == b"meta").ok_or("HEIF without meta box")?;
    let kids = bmff_boxes(b, meta.2 + 4, meta.3)?; // meta is a FullBox
    let mut h = HeifItems { items: vec![], locs: vec![], dims: None, icc: 0, brand };
    let idat = kids.iter().find(|x| &x.0 == b"idat").map(|x| x.2);
    for (typ, _, p, end) in &kids {
        match typ {
            b"iinf" => {
                let ver = b[*p];
                let first = if ver == 0 { p + 6 } else { p + 8 };
                for (t, _, ip, ie) in bmff_boxes(b, first, *end)? {
                    if &t != b"infe" || b[ip] < 2 {
                        continue;
                    }
                    let (id, q) = if b[ip] == 2 {
                        (be16(b, ip + 4).ok_or("bad infe")? as u32, ip + 6)
                    } else {
                        (be32(b, ip + 4).ok_or("bad infe")?, ip + 8)
                    };
                    let itype: [u8; 4] = b.get(q + 2..q + 6).ok_or("bad infe")?.try_into().unwrap();
                    let mut ct = String::new();
                    if &itype == b"mime" {
                        let rest = &b[(q + 6).min(ie)..ie];
                        let name_end = rest.iter().position(|&c| c == 0).map(|x| x + 1).unwrap_or(rest.len());
                        ct = png_text_key(&rest[name_end..]);
                    }
                    h.items.push((id, itype, ct));
                }
            }
            b"iloc" => {
                let ver = b[*p];
                let mut q = p + 4;
                let (os, ls) = ((b[q] >> 4) as usize, (b[q] & 15) as usize);
                let (bs, is) = ((b[q + 1] >> 4) as usize, if ver >= 1 { (b[q + 1] & 15) as usize } else { 0 });
                q += 2;
                let count = if ver < 2 { let c = be16(b, q).ok_or("bad iloc")? as usize; q += 2; c } else { let c = be32(b, q).ok_or("bad iloc")? as usize; q += 4; c };
                for _ in 0..count {
                    let id = if ver < 2 { let c = be16(b, q).ok_or("bad iloc")? as u32; q += 2; c } else { let c = be32(b, q).ok_or("bad iloc")?; q += 4; c };
                    let method = if ver >= 1 { let c = be16(b, q).ok_or("bad iloc")? & 15; q += 2; c } else { 0 };
                    q += 2; // data_reference_index
                    let base = read_n(b, q, bs).ok_or("bad iloc")? as usize;
                    q += bs;
                    let n = be16(b, q).ok_or("bad iloc")? as usize;
                    q += 2;
                    let mut ext = vec![];
                    for _ in 0..n {
                        q += is;
                        let off = read_n(b, q, os).ok_or("bad iloc")? as usize;
                        q += os;
                        let len = read_n(b, q, ls).ok_or("bad iloc")? as usize;
                        q += ls;
                        let abs = match method {
                            0 => base + off,
                            1 => idat.ok_or("iloc idat without idat box")? + base + off,
                            _ => continue, // item-offset construction: never metadata in practice
                        };
                        ext.push((abs, len));
                    }
                    h.locs.push((id, ext));
                }
            }
            b"iprp" => {
                for (t, _, pp, pe) in bmff_boxes(b, *p, *end)? {
                    if &t != b"ipco" {
                        continue;
                    }
                    for (pt, _, xp, _) in bmff_boxes(b, pp, pe)? {
                        if &pt == b"ispe" {
                            if let (Some(w), Some(hh)) = (be32(b, xp + 4), be32(b, xp + 8)) {
                                if h.dims.map_or(true, |(a, c)| (w as u64) * (hh as u64) > (a as u64) * (c as u64)) {
                                    h.dims = Some((w, hh));
                                }
                            }
                        }
                        if &pt == b"colr" && b.get(xp..xp + 4).map_or(false, |c| c == b"prof" || c == b"rICC") {
                            h.icc += pt.len(); // presence only; size below
                        }
                    }
                }
            }
            _ => {}
        }
    }
    Ok(h)
}

fn heif_item_bytes(b: &[u8], ext: &[(usize, usize)]) -> Option<Vec<u8>> {
    let mut v = Vec::new();
    for &(o, l) in ext {
        v.extend_from_slice(b.get(o..o.checked_add(l)?)?);
    }
    Some(v)
}

fn heif_meta_items(h: &HeifItems) -> Vec<(&'static str, &Vec<(usize, usize)>)> {
    let mut v = vec![];
    for (id, t, ct) in &h.items {
        let kind = if t == b"Exif" {
            "exif"
        } else if t == b"mime" && ct.contains("rdf+xml") {
            "xmp"
        } else {
            continue;
        };
        if let Some((_, ext)) = h.locs.iter().find(|l| l.0 == *id) {
            v.push((kind, ext));
        }
    }
    v
}

/// Exif item payload: u32 offset to the TIFF header, then (usually "Exif\0\0") + TIFF.
fn heif_exif_tiff(item: &[u8]) -> Option<&[u8]> {
    let off = be32(item, 0)? as usize;
    item.get(4 + off..)
}

fn heif_scan(b: &[u8]) -> Result<Meta, String> {
    let h = heif_parse(b)?;
    let mut m = Meta { format: format!("HEIF ({})", h.brand), dims: h.dims, ..Default::default() };
    m.icc_bytes = h.icc; // presence marker (size not tracked for colr)
    for (kind, ext) in heif_meta_items(&h) {
        let Some(data) = heif_item_bytes(b, ext) else { continue };
        if kind == "exif" {
            if let Some(t) = heif_exif_tiff(&data) {
                if parse_exif(t).tags == 0 {
                    continue; // already blanked
                }
                m.exif_bytes += data.len();
                if m.exif.is_none() {
                    m.exif = Some(t.to_vec());
                }
            }
        } else if data.iter().any(|&c| c == b'<') && !is_blank_xmp(&data) {
            m.xmp_bytes += data.len();
        }
    }
    Ok(m)
}

const BLANK_XMP: &[u8] = b"<?xpacket begin=\"\" id=\"W5M0MpCehiHzreSzNTczkc9d\"?><x:xmpmeta xmlns:x=\"adobe:ns:meta/\"/><?xpacket end=\"w\"?>";

fn is_blank_xmp(d: &[u8]) -> bool {
    d.starts_with(BLANK_XMP) && d[BLANK_XMP.len()..].iter().all(|&c| c == b' ')
}

fn heif_strip(b: &[u8], keep_orientation: bool) -> Result<Stripped, String> {
    let h = heif_parse(b)?;
    let mut out = b.to_vec();
    let mut removed = Vec::new();
    for (kind, ext) in heif_meta_items(&h) {
        let Some(data) = heif_item_bytes(b, ext) else { continue };
        let fill = if kind == "exif" {
            let tiff = heif_exif_tiff(&data);
            let info = tiff.map(parse_exif).unwrap_or_default();
            if info.gps {
                push_label(&mut removed, "gps");
            }
            let o = if keep_orientation { orientation_of(tiff) } else { None };
            let mut v = 0u32.to_be_bytes().to_vec();
            v.extend_from_slice(&minimal_tiff(o));
            if v.len() > data.len() {
                v = 0u32.to_be_bytes().to_vec();
                v.extend_from_slice(&minimal_tiff(None));
            }
            v.resize(data.len(), 0);
            v
        } else {
            let mut v = if BLANK_XMP.len() <= data.len() { BLANK_XMP.to_vec() } else { vec![] };
            v.resize(data.len(), b' ');
            v
        };
        if fill == data {
            continue;
        }
        push_label(&mut removed, kind);
        let mut k = 0;
        for &(o, l) in ext.iter() {
            out[o..o + l].copy_from_slice(&fill[k..k + l]);
            k += l;
        }
    }
    Ok(Stripped { out, removed })
}

// --------------------------------------------------------------- driver

fn scan(b: &[u8]) -> Result<Meta, String> {
    match detect(b).ok_or("unsupported format")? {
        Kind::Jpeg => jpeg_scan(b),
        Kind::Png => png_scan(b),
        Kind::Webp => webp_scan(b),
        Kind::Heif => heif_scan(b),
    }
}

fn strip(b: &[u8], keep_orientation: bool, keep_icc: bool) -> Result<Stripped, String> {
    match detect(b).ok_or("unsupported format")? {
        Kind::Jpeg => jpeg_strip(b, keep_orientation, keep_icc),
        Kind::Png => png_strip(b, keep_orientation, keep_icc),
        Kind::Webp => webp_strip(b, keep_orientation, keep_icc),
        Kind::Heif => heif_strip(b, keep_orientation),
    }
}

fn show(path: &str, b: &[u8]) -> Result<String, String> {
    let m = scan(b)?;
    let mut s = String::new();
    let dims = m.dims.map(|(w, h)| format!(" {w}x{h}")).unwrap_or_default();
    let _ = writeln!(s, "{path}: {}{dims}", m.format);
    let info = m.exif.as_deref().map(parse_exif);
    let mut any = false;
    if m.exif_bytes > 0 {
        any = true;
        let i = info.as_ref().unwrap();
        let _ = writeln!(s, "  exif: {} bytes, {} tags{}", m.exif_bytes, i.tags, if i.thumbnail { ", thumbnail" } else { "" });
        let cam = match (&i.make, &i.model) {
            (Some(a), Some(b)) if b.starts_with(a.as_str()) => Some(b.clone()),
            (Some(a), Some(b)) => Some(format!("{a} {b}")),
            (Some(a), None) | (None, Some(a)) => Some(a.clone()),
            _ => None,
        };
        if let Some(c) = cam {
            let _ = writeln!(s, "  camera: {c}");
        }
        if let Some(d) = &i.date {
            let _ = writeln!(s, "  date: {d}");
        }
        if let Some(o) = i.orientation {
            let _ = writeln!(s, "  orientation: {o}");
        }
        match (i.gps, i.gps_pos) {
            (true, Some((a, o))) => { let _ = writeln!(s, "  gps: yes ({a:.6}, {o:.6})"); }
            (true, None) => { let _ = writeln!(s, "  gps: yes"); }
            _ => { let _ = writeln!(s, "  gps: no"); }
        }
    }
    if m.xmp_bytes > 0 {
        any = true;
        let _ = writeln!(s, "  xmp: {} bytes", m.xmp_bytes);
    }
    if m.icc_bytes > 0 {
        let _ = writeln!(s, "  icc: yes");
    }
    if !m.other.is_empty() {
        any = true;
        let _ = writeln!(s, "  other: {}", m.other.join(", "));
    }
    if !any {
        let _ = writeln!(s, "  metadata: none");
    }
    Ok(s)
}

/// Lexically normalize a relative/absolute path (no fs access).
fn normalize(p: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for c in p.components() {
        match c {
            Component::CurDir => {}
            Component::ParentDir => {
                if !out.pop() {
                    out.push("..");
                }
            }
            c => out.push(c.as_os_str()),
        }
    }
    out
}

/// Collect files under `root` (sorted, recursive, skipping dot-entries and `skip`).
fn walk(root: &Path, skip: Option<&Path>, out: &mut Vec<PathBuf>) -> std::io::Result<()> {
    let mut entries: Vec<_> = fs::read_dir(root)?.filter_map(|e| e.ok()).collect();
    entries.sort_by_key(|e| e.file_name());
    for e in entries {
        let name = e.file_name();
        if name.to_string_lossy().starts_with('.') {
            continue;
        }
        let p = root.join(&name);
        if skip.map_or(false, |s| normalize(&p) == s) {
            continue;
        }
        let ft = e.file_type()?;
        if ft.is_dir() {
            walk(&p, skip, out)?;
        } else if ft.is_file() {
            out.push(p);
        }
    }
    Ok(())
}

/// Expand args into (input path, output-relative path, from_dir).
fn expand(args: &[String], skip: Option<&Path>, errs: &mut u32) -> Vec<(PathBuf, PathBuf, bool)> {
    let mut v = Vec::new();
    for a in args {
        let p = Path::new(a);
        match fs::metadata(p) {
            Ok(md) if md.is_dir() => {
                let mut files = Vec::new();
                if let Err(e) = walk(p, skip, &mut files) {
                    eprintln!("exifstrip: {a}: {e}");
                    *errs += 1;
                    continue;
                }
                let base = normalize(p);
                let prefix = base.file_name().map(PathBuf::from).unwrap_or_default();
                for f in files {
                    let rel = f.strip_prefix(p).map(|r| r.to_path_buf()).unwrap_or_else(|_| f.clone());
                    v.push((f, prefix.join(rel), true));
                }
            }
            Ok(_) => {
                let name = p.file_name().map(PathBuf::from).unwrap_or_else(|| p.to_path_buf());
                v.push((p.to_path_buf(), name, false));
            }
            Err(e) => {
                eprintln!("exifstrip: {a}: {e}");
                *errs += 1;
            }
        }
    }
    v
}

fn cmd_strip(args: &[String]) -> ExitCode {
    let (mut keep_o, mut keep_icc, mut outdir, mut files) = (false, false, None::<String>, Vec::new());
    let mut it = args.iter();
    let mut opts_done = false;
    while let Some(a) = it.next() {
        match a.as_str() {
            "--" if !opts_done => opts_done = true,
            "--keep-orientation" if !opts_done => keep_o = true,
            "--keep-icc" if !opts_done => keep_icc = true,
            "-o" | "--out" if !opts_done => match it.next() {
                Some(d) => outdir = Some(d.clone()),
                None => return usage_err("-o needs a directory"),
            },
            s if !opts_done && s.starts_with('-') && s.len() > 1 => return usage_err(&format!("unknown option {s}")),
            _ => files.push(a.clone()),
        }
    }
    if files.is_empty() {
        return usage_err("strip: no files given");
    }
    let skip = outdir.as_deref().map(|d| normalize(Path::new(d)));
    let mut failed = 0u32;
    let list = expand(&files, skip.as_deref(), &mut failed);
    let (mut n_strip, mut n_clean) = (0u32, 0u32);
    for (src, rel, from_dir) in &list {
        let shown = src.display().to_string();
        let data = match fs::read(src) {
            Ok(d) => d,
            Err(e) => {
                eprintln!("exifstrip: {shown}: {e}");
                failed += 1;
                continue;
            }
        };
        if detect(&data).is_none() {
            if *from_dir {
                continue; // non-image files inside a directory are ignored
            }
            eprintln!("exifstrip: {shown}: unsupported format (JPEG, PNG, WebP, HEIF)");
            failed += 1;
            continue;
        }
        let r = match strip(&data, keep_o, keep_icc) {
            Ok(r) => r,
            Err(e) => {
                eprintln!("exifstrip: {shown}: {e}");
                failed += 1;
                continue;
            }
        };
        let changed = r.out != data;
        let dest = match &outdir {
            Some(d) => Path::new(d).join(rel),
            None => src.clone(),
        };
        if changed || outdir.is_some() {
            if let Some(parent) = dest.parent() {
                if !parent.as_os_str().is_empty() {
                    if let Err(e) = fs::create_dir_all(parent) {
                        eprintln!("exifstrip: {}: {e}", parent.display());
                        failed += 1;
                        continue;
                    }
                }
            }
            if let Err(e) = fs::write(&dest, if changed { &r.out } else { &data }) {
                eprintln!("exifstrip: {}: {e}", dest.display());
                failed += 1;
                continue;
            }
        }
        let arrow = if outdir.is_some() { format!(" -> {}", dest.display()) } else { String::new() };
        if changed {
            n_strip += 1;
            let delta = data.len() as i64 - r.out.len() as i64;
            let size = if delta == 0 { "erased in place".to_string() } else { format!("-{delta} bytes") };
            println!("stripped {shown}{arrow}: {} ({size})", r.removed.join(" "));
        } else {
            n_clean += 1;
            println!("clean    {shown}{arrow}");
        }
    }
    println!("{} file(s): {n_strip} stripped, {n_clean} clean, {failed} failed", n_strip + n_clean + failed);
    if failed > 0 { ExitCode::from(1) } else { ExitCode::SUCCESS }
}

fn cmd_show(args: &[String]) -> ExitCode {
    if args.is_empty() {
        return usage_err("show: no files given");
    }
    let mut failed = 0u32;
    let list = expand(args, None, &mut failed);
    for (src, _, from_dir) in &list {
        let shown = src.display().to_string();
        let data = match fs::read(src) {
            Ok(d) => d,
            Err(e) => {
                eprintln!("exifstrip: {shown}: {e}");
                failed += 1;
                continue;
            }
        };
        if *from_dir && detect(&data).is_none() {
            continue;
        }
        match show(&shown, &data) {
            Ok(s) => print!("{s}"),
            Err(e) => {
                eprintln!("exifstrip: {shown}: {e}");
                failed += 1;
            }
        }
    }
    if failed > 0 { ExitCode::from(1) } else { ExitCode::SUCCESS }
}

fn usage_err(msg: &str) -> ExitCode {
    eprintln!("exifstrip: {msg}\n\n{USAGE}");
    ExitCode::from(2)
}

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args.first().map(String::as_str) {
        Some("strip") => cmd_strip(&args[1..]),
        Some("show") => cmd_show(&args[1..]),
        Some("-h") | Some("--help") | Some("help") => {
            print!("{USAGE}");
            ExitCode::SUCCESS
        }
        Some("-V") | Some("--version") => {
            println!("exifstrip {VERSION}");
            ExitCode::SUCCESS
        }
        Some(c) => usage_err(&format!("unknown command {c}")),
        None => usage_err("missing command"),
    }
}

#[cfg(test)]
mod tests;
