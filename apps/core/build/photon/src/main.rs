// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-UEL
// Copyright (C) 2026 And The Next GmbH - https://userland.run
//
// `photon` for the nano wasm runner (runners/wasm), compiled to wasm32-wasip1.
//
// A tiny image-processing CLI in the spirit of Photon (silvia-odwyer/photon):
// read an image file, apply a filter, write the result. Built on the pure-Rust
// `image` crate (PNG/JPEG decode, built-in ops) plus a couple of Photon-style
// plain-pixel-buffer effects (sepia, threshold) — all wasip1-friendly, no
// wasm-bindgen, no threads.
//
// Usage:  photon <in> <out> [--filter NAME] [--strength N]
//   filters: grayscale, invert, blur, brighten, sepia, threshold
// Output is always PNG. stdout is a one-line summary (binary goes to the file,
// since the wasm runner decodes stdout as UTF-8).

use image::{DynamicImage, GenericImageView, ImageFormat};
use std::env;
use std::process::ExitCode;

#[derive(Default)]
struct Opts {
    input: Option<String>,
    output: Option<String>,
    filter: String,
    strength: Option<f32>,
}

fn parse(args: &[String]) -> Result<Opts, String> {
    let mut o = Opts { filter: "grayscale".into(), ..Default::default() };
    let mut i = 1;
    while i < args.len() {
        match args[i].as_str() {
            "-h" | "--help" => return Err(String::new()),
            "-f" | "--filter" => {
                i += 1;
                o.filter = args.get(i).ok_or("--filter needs a value")?.clone();
            }
            "-s" | "--strength" => {
                i += 1;
                o.strength = Some(args.get(i).ok_or("--strength needs a value")?.parse().map_err(|_| "bad --strength")?);
            }
            s if s.starts_with('-') => { /* ignore unknown flags */ }
            s => {
                if o.input.is_none() {
                    o.input = Some(s.to_string());
                } else if o.output.is_none() {
                    o.output = Some(s.to_string());
                }
            }
        }
        i += 1;
    }
    Ok(o)
}

fn usage() -> &'static str {
    "usage: photon <in> <out> [--filter grayscale|invert|blur|brighten|sepia|threshold] [--strength N]"
}

fn apply(filter: &str, strength: Option<f32>, img: DynamicImage) -> DynamicImage {
    match filter {
        "grayscale" | "gray" => img.grayscale(),
        "invert" => {
            let mut b = img.to_rgba8();
            image::imageops::invert(&mut b);
            DynamicImage::ImageRgba8(b)
        }
        "blur" => img.blur(strength.unwrap_or(4.0)),
        "brighten" => img.brighten(strength.unwrap_or(40.0) as i32),
        "sepia" => sepia(img),
        "threshold" => threshold(img, strength.unwrap_or(128.0) as u8),
        other => {
            eprintln!("photon: unknown filter '{other}', using grayscale");
            img.grayscale()
        }
    }
}

/// Photon-style sepia: a plain per-pixel RGB matrix over the buffer.
fn sepia(img: DynamicImage) -> DynamicImage {
    let mut b = img.to_rgba8();
    for p in b.pixels_mut() {
        let [r, g, bl, a] = p.0;
        let (rf, gf, bf) = (r as f32, g as f32, bl as f32);
        let nr = (0.393 * rf + 0.769 * gf + 0.189 * bf).min(255.0) as u8;
        let ng = (0.349 * rf + 0.686 * gf + 0.168 * bf).min(255.0) as u8;
        let nb = (0.272 * rf + 0.534 * gf + 0.131 * bf).min(255.0) as u8;
        p.0 = [nr, ng, nb, a];
    }
    DynamicImage::ImageRgba8(b)
}

/// Photon-style luminance threshold to black/white.
fn threshold(img: DynamicImage, t: u8) -> DynamicImage {
    let mut b = img.to_rgba8();
    for p in b.pixels_mut() {
        let [r, g, bl, a] = p.0;
        let lum = (0.299 * r as f32 + 0.587 * g as f32 + 0.114 * bl as f32) as u8;
        let v = if lum >= t { 255 } else { 0 };
        p.0 = [v, v, v, a];
    }
    DynamicImage::ImageRgba8(b)
}

fn run() -> Result<String, (u8, String)> {
    let args: Vec<String> = env::args().collect();
    let o = parse(&args).map_err(|e| (2u8, if e.is_empty() { usage().to_string() } else { format!("{e}\n{}", usage()) }))?;
    let (input, output) = match (o.input.clone(), o.output.clone()) {
        (Some(a), Some(b)) => (a, b),
        _ => return Err((2, usage().to_string())),
    };
    let img = image::open(&input).map_err(|e| (1u8, format!("photon: cannot read {input}: {e}")))?;
    let (w, h) = img.dimensions();
    let out = apply(&o.filter, o.strength, img);
    out.save_with_format(&output, ImageFormat::Png)
        .map_err(|e| (1u8, format!("photon: cannot write {output}: {e}")))?;
    Ok(format!("photon: {} {w}x{h} -> {output} ({}x{} PNG)", o.filter, out.width(), out.height()))
}

fn main() -> ExitCode {
    match run() {
        Ok(msg) => {
            println!("{msg}");
            ExitCode::SUCCESS
        }
        Err((code, msg)) => {
            eprintln!("{msg}");
            ExitCode::from(code)
        }
    }
}
