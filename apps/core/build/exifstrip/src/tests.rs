// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-UEL
// Host tests: every fixture is decoded before and after stripping and must give
// identical pixels; the metadata must be gone (show reports none / no GPS).

use super::*;

const JPG: &[u8] = include_bytes!("../tests/fixtures/photo.jpg");
const PNG: &[u8] = include_bytes!("../tests/fixtures/photo.png");
const WEBP: &[u8] = include_bytes!("../tests/fixtures/photo.webp");
const HEIC: &[u8] = include_bytes!("../tests/fixtures/photo.heic");
const CLEAN: &[u8] = include_bytes!("../tests/fixtures/clean.png");

fn pixels(b: &[u8]) -> Vec<u8> {
    image::load_from_memory(b).expect("decode").to_rgba8().into_raw()
}

fn check_lossless(b: &[u8], keep_o: bool, keep_icc: bool) -> Stripped {
    let r = strip(b, keep_o, keep_icc).expect("strip");
    assert_eq!(pixels(b), pixels(&r.out), "pixels changed");
    // Idempotent: a second pass changes nothing.
    let r2 = strip(&r.out, keep_o, keep_icc).expect("strip2");
    assert_eq!(r2.out, r.out, "not idempotent");
    r
}

#[test]
fn fixtures_carry_metadata() {
    for b in [JPG, PNG, WEBP, HEIC] {
        let m = scan(b).unwrap();
        let i = parse_exif(m.exif.as_deref().expect("exif"));
        assert!(i.gps, "{} has gps", m.format);
        assert_eq!(i.orientation, Some(6));
        let (lat, lon) = i.gps_pos.unwrap();
        assert!((lat - 47.2692).abs() < 1e-3 && (lon - 11.4041).abs() < 1e-3, "{lat},{lon}");
    }
}

#[test]
fn jpeg_png_webp_lossless() {
    for b in [JPG, PNG, WEBP] {
        let r = check_lossless(b, false, false);
        assert!(r.removed.iter().any(|x| x == "exif") && r.removed.iter().any(|x| x == "gps"));
        assert!(r.removed.iter().any(|x| x == "xmp") && r.removed.iter().any(|x| x == "icc"));
        let m = scan(&r.out).unwrap();
        assert!(m.exif.is_none() && m.exif_bytes == 0 && m.xmp_bytes == 0 && m.icc_bytes == 0 && m.other.is_empty(), "{}", m.format);
        assert!(show("x", &r.out).unwrap().contains("metadata: none"));
    }
}

#[test]
fn keep_orientation_and_icc() {
    for b in [JPG, PNG, WEBP] {
        let r = check_lossless(b, true, true);
        let m = scan(&r.out).unwrap();
        let i = parse_exif(m.exif.as_deref().expect("orientation exif"));
        assert_eq!(i.orientation, Some(6));
        assert!(!i.gps && i.make.is_none() && i.tags == 1);
        assert!(m.icc_bytes > 0, "{} icc kept", m.format);
        assert_eq!(m.xmp_bytes, 0);
    }
}

#[test]
fn heif_blanked_in_place() {
    let r = strip(HEIC, false, false).unwrap();
    assert_eq!(r.out.len(), HEIC.len());
    assert!(r.removed.iter().any(|x| x == "exif") && r.removed.iter().any(|x| x == "gps"));
    let m = scan(&r.out).unwrap();
    assert!(m.exif.is_none());
    // Only bytes inside the Exif/XMP items changed.
    let h = heif_parse(HEIC).unwrap();
    let ranges: Vec<_> = heif_meta_items(&h).into_iter().flat_map(|(_, e)| e.clone()).collect();
    for (k, (a, b)) in HEIC.iter().zip(r.out.iter()).enumerate() {
        if a != b {
            assert!(ranges.iter().any(|&(o, l)| k >= o && k < o + l), "byte {k} outside metadata items changed");
        }
    }
    let r2 = strip(&r.out, false, false).unwrap();
    assert_eq!(r2.out, r.out);
    let r3 = strip(HEIC, true, false).unwrap();
    assert_eq!(parse_exif(scan(&r3.out).unwrap().exif.as_deref().unwrap()).orientation, Some(6));
}

#[test]
fn clean_file_untouched() {
    let r = strip(CLEAN, false, false).unwrap();
    assert_eq!(r.out, CLEAN);
    assert!(r.removed.is_empty());
}

#[test]
fn rejects_garbage() {
    assert!(scan(b"GIF89a....").is_err());
    let mut t = JPG[..200].to_vec();
    t[150] = 0x00;
    let _ = strip(&t, false, false); // must not panic
    for n in [0, 3, 9, 13, 40, 100] {
        for b in [JPG, PNG, WEBP, HEIC] {
            let _ = strip(&b[..n.min(b.len())], false, false);
            let _ = scan(&b[..n.min(b.len())]);
        }
    }
}
