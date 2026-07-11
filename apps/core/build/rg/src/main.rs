// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-UEL
// Copyright (C) 2026 And The Next GmbH - https://userland.run
//
// `rg` for the nano wasm runner (runners/wasm), compiled to wasm32-wasip1.
//
// Built on ripgrep's OWN engine crates — `ignore` (gitignore-aware, hidden-
// handling, glob-override directory walking) and `regex` (the same matcher) —
// so the semantics are ripgrep's, not a reimplementation. Single-threaded
// (`Walk`, not `WalkParallel`) and std-only I/O so it runs on wasip1.
//
// Supported: search + `--files`; flags -i/-S/-w/-F/-v, -n/-N, -H/--no-filename,
// -l/--files-with-matches, --files-without-match, -c/--count, -o/--only-matching,
// -A/-B/-C context, -g/--glob (repeatable), --hidden, --no-ignore, --json,
// -e/--regexp, -m/--max-count, --color (ignored), --no-config (ignored).
// Not yet: PCRE2 (-P), multiline (-U), replacements, type filters.

use ignore::overrides::OverrideBuilder;
use ignore::WalkBuilder;
use regex::bytes::{Regex, RegexBuilder};
use std::io::{self, Read, Write};
use std::path::Path;

#[derive(Default)]
struct Opts {
    files_mode: bool,
    patterns: Vec<String>,
    paths: Vec<String>,
    ignore_case: bool,
    smart_case: bool,
    word: bool,
    fixed: bool,
    invert: bool,
    line_number: bool,
    no_line_number: bool,
    with_filename: bool,
    no_filename: bool,
    files_with_matches: bool,
    files_without_match: bool,
    count: bool,
    only_matching: bool,
    hidden: bool,
    no_ignore: bool,
    globs: Vec<String>,
    before: usize,
    after: usize,
    json: bool,
    max_count: Option<usize>,
}

fn main() {
    let opts = match parse(std::env::args().skip(1)) {
        Ok(o) => o,
        Err(msg) => {
            eprintln!("rg: {}", msg);
            std::process::exit(2);
        }
    };
    let code = run(&opts);
    std::process::exit(code);
}

fn parse<I: Iterator<Item = String>>(args: I) -> Result<Opts, String> {
    let mut o = Opts::default();
    let mut pat_from_flag = false;
    let mut only_positional = false;
    let mut pending_pattern: Option<String> = None;
    let mut it = args.peekable();
    while let Some(a) = it.next() {
        if only_positional || !a.starts_with('-') || a == "-" {
            // First bare arg is the PATTERN (unless -e gave one); rest are paths.
            if o.patterns.is_empty() && !pat_from_flag && !o.files_mode && pending_pattern.is_none() {
                pending_pattern = Some(a);
            } else {
                o.paths.push(a);
            }
            continue;
        }
        if a == "--" {
            only_positional = true;
            continue;
        }
        // long options
        if let Some(rest) = a.strip_prefix("--") {
            let (name, inline_val) = match rest.split_once('=') {
                Some((n, v)) => (n, Some(v.to_string())),
                None => (rest, None),
            };
            let mut take = |it: &mut std::iter::Peekable<I>| inline_val.clone().or_else(|| it.next());
            match name {
                "files" => o.files_mode = true,
                "ignore-case" => o.ignore_case = true,
                "smart-case" => o.smart_case = true,
                "word-regexp" => o.word = true,
                "fixed-strings" => o.fixed = true,
                "invert-match" => o.invert = true,
                "line-number" => o.line_number = true,
                "no-line-number" => o.no_line_number = true,
                "with-filename" => o.with_filename = true,
                "no-filename" => o.no_filename = true,
                "files-with-matches" => o.files_with_matches = true,
                "files-without-match" => o.files_without_match = true,
                "count" => o.count = true,
                "only-matching" => o.only_matching = true,
                "hidden" => o.hidden = true,
                "no-ignore" => o.no_ignore = true,
                "json" => o.json = true,
                "regexp" => { o.patterns.push(take(&mut it).ok_or("--regexp needs a value")?); pat_from_flag = true; }
                "glob" => o.globs.push(take(&mut it).ok_or("--glob needs a value")?),
                "max-count" => o.max_count = Some(take(&mut it).ok_or("--max-count needs a value")?.parse().map_err(|_| "bad --max-count")?),
                "after-context" => o.after = take(&mut it).ok_or("needs value")?.parse().map_err(|_| "bad -A")?,
                "before-context" => o.before = take(&mut it).ok_or("needs value")?.parse().map_err(|_| "bad -B")?,
                "context" => { let n = take(&mut it).ok_or("needs value")?.parse().map_err(|_| "bad -C")?; o.before = n; o.after = n; }
                // ignored (compat): color, config, sorting, threads, etc.
                "color" | "colors" | "sort" | "sortr" | "threads" | "max-columns" | "max-filesize" | "type" | "type-not" => { let _ = take(&mut it); }
                "no-config" | "no-heading" | "heading" | "vimgrep" | "null" | "no-messages" | "hidden-not" | "stats" | "trim" => {}
                _ => { /* tolerate unknown long flags */ }
            }
            continue;
        }
        // short option cluster (-inH, -A2, -g glob)
        let chars: Vec<char> = a[1..].chars().collect();
        let mut idx = 0;
        while idx < chars.len() {
            let c = chars[idx];
            match c {
                'i' => o.ignore_case = true,
                'S' => o.smart_case = true,
                'w' => o.word = true,
                'F' => o.fixed = true,
                'v' => o.invert = true,
                'n' => o.line_number = true,
                'N' => o.no_line_number = true,
                'H' => o.with_filename = true,
                'l' => o.files_with_matches = true,
                'c' => o.count = true,
                'o' => o.only_matching = true,
                '.' => o.hidden = true, // -. = --hidden
                'e' | 'g' | 'A' | 'B' | 'C' | 'm' => {
                    let val: String = if idx + 1 < chars.len() { chars[idx + 1..].iter().collect() } else { it.next().ok_or("option needs a value")? };
                    match c {
                        'e' => { o.patterns.push(val); pat_from_flag = true; }
                        'g' => o.globs.push(val),
                        'A' => o.after = val.parse().map_err(|_| "bad -A")?,
                        'B' => o.before = val.parse().map_err(|_| "bad -B")?,
                        'C' => { let n = val.parse().map_err(|_| "bad -C")?; o.before = n; o.after = n; }
                        'm' => o.max_count = Some(val.parse().map_err(|_| "bad -m")?),
                        _ => unreachable!(),
                    }
                    idx = chars.len();
                    break;
                }
                _ => { /* tolerate unknown short flags */ }
            }
            idx += 1;
        }
    }
    if let Some(p) = pending_pattern {
        o.patterns.push(p);
    }
    Ok(o)
}

fn run(o: &Opts) -> i32 {
    let roots: Vec<String> = if o.paths.is_empty() { vec![".".to_string()] } else { o.paths.clone() };

    if o.files_mode {
        let out = io::stdout();
        let mut w = io::BufWriter::new(out.lock());
        let mut any = false;
        for entry in walk(o, &roots) {
            if let Some(path) = entry {
                any = true;
                let _ = writeln!(w, "{}", display_path(&path));
            }
        }
        let _ = w.flush();
        return if any { 0 } else { 1 };
    }

    if o.patterns.is_empty() {
        eprintln!("rg: no pattern given");
        return 2;
    }
    let re = match build_regex(o) {
        Ok(r) => r,
        Err(e) => { eprintln!("rg: {}", e); return 2; }
    };

    // Filename prefix: on when recursing or multiple paths, off for a single file.
    let multi = roots.len() > 1 || roots.iter().any(|p| Path::new(p).is_dir());
    let show_name = o.with_filename || (!o.no_filename && multi);
    let show_line = (o.line_number || multi) && !o.no_line_number;

    let out = io::stdout();
    let mut w = io::BufWriter::new(out.lock());
    let mut total_matches = 0usize;
    let mut matched_files = 0usize;

    for entry in walk(o, &roots) {
        let path = match entry { Some(p) => p, None => continue };
        let data = match read_file(&path) { Some(d) => d, None => continue };
        if is_binary(&data) { continue; }
        let name = display_path(&path);
        let n = search_file(o, &re, &name, &data, show_name, show_line, &mut w);
        if n > 0 { matched_files += 1; }
        total_matches += n;
    }
    let _ = w.flush();
    if o.files_with_matches || o.files_without_match {
        return if matched_files > 0 || o.files_without_match { 0 } else { 1 };
    }
    if total_matches > 0 { 0 } else { 1 }
}

fn build_regex(o: &Opts) -> Result<Regex, String> {
    let mut parts: Vec<String> = Vec::new();
    for p in &o.patterns {
        let mut pat = if o.fixed { regex::escape(p) } else { p.clone() };
        if o.word { pat = format!(r"\b(?:{})\b", pat); }
        parts.push(format!("(?:{})", pat));
    }
    let joined = parts.join("|");
    let ci = o.ignore_case || (o.smart_case && !o.patterns.iter().any(|p| p.chars().any(|c| c.is_uppercase())));
    RegexBuilder::new(&joined)
        .case_insensitive(ci)
        .build()
        .map_err(|e| format!("invalid regex: {}", e))
}

fn walk(o: &Opts, roots: &[String]) -> Vec<Option<String>> {
    let mut builder = WalkBuilder::new(&roots[0]);
    for r in &roots[1..] { builder.add(r); }
    builder
        .hidden(!o.hidden)
        .git_ignore(!o.no_ignore)
        .git_global(!o.no_ignore)
        .git_exclude(!o.no_ignore)
        .ignore(!o.no_ignore)
        .parents(!o.no_ignore)
        // Honor .gitignore even when the project isn't a git checkout (the guest
        // VFS rarely has a .git dir) — otherwise ignore rules are silently off.
        .require_git(false);
    if !o.globs.is_empty() {
        let mut ob = OverrideBuilder::new(&roots[0]);
        for g in &o.globs { let _ = ob.add(g); }
        if let Ok(ov) = ob.build() { builder.overrides(ov); }
    }
    let mut out = Vec::new();
    for res in builder.build() {
        match res {
            Ok(e) => {
                if e.file_type().map(|t| t.is_file()).unwrap_or(false) {
                    out.push(Some(e.path().to_string_lossy().into_owned()));
                }
            }
            Err(_) => {}
        }
    }
    out
}

fn read_file(path: &str) -> Option<Vec<u8>> {
    let mut f = std::fs::File::open(path).ok()?;
    let mut buf = Vec::new();
    f.read_to_end(&mut buf).ok()?;
    Some(buf)
}

// Cheap binary sniff: a NUL in the first 8 KiB.
fn is_binary(data: &[u8]) -> bool {
    data.iter().take(8192).any(|&b| b == 0)
}

fn search_file(
    o: &Opts,
    re: &Regex,
    name: &str,
    data: &[u8],
    show_name: bool,
    show_line: bool,
    w: &mut impl Write,
) -> usize {
    let lines: Vec<&[u8]> = split_lines(data);
    let mut matches = 0usize;
    let mut printed_ctx_upto: isize = -1;

    // -l / --files-with-matches / --files-without-match: presence only.
    if o.files_with_matches || o.files_without_match {
        let hit = lines.iter().any(|ln| re.is_match(ln) != o.invert);
        if (hit && o.files_with_matches) || (!hit && o.files_without_match) {
            let _ = writeln!(w, "{}", name);
            return if hit { 1 } else { 0 };
        }
        return if hit { 1 } else { 0 };
    }

    // -c / --count.
    if o.count {
        let c = lines.iter().filter(|ln| re.is_match(ln) != o.invert).count();
        if c > 0 {
            if show_name { let _ = writeln!(w, "{}:{}", name, c); } else { let _ = writeln!(w, "{}", c); }
        }
        return c;
    }

    for (i, ln) in lines.iter().enumerate() {
        let is_match = re.is_match(ln) != o.invert;
        if !is_match { continue; }
        matches += 1;
        if let Some(mc) = o.max_count { if matches > mc { break; } }
        let lineno = i + 1;

        if o.json {
            emit_json_match(w, name, lineno, ln, re);
            continue;
        }
        if o.only_matching && !o.invert {
            for m in re.find_iter(ln) {
                write_prefix(w, name, lineno, show_name, show_line);
                let _ = w.write_all(&ln[m.start()..m.end()]);
                let _ = w.write_all(b"\n");
            }
            continue;
        }
        // context before
        if o.before > 0 {
            let start = i.saturating_sub(o.before);
            for j in start..i {
                if (j as isize) > printed_ctx_upto {
                    write_context(w, name, j + 1, lines[j], show_name, show_line);
                }
            }
        }
        write_prefix(w, name, lineno, show_name, show_line);
        let _ = w.write_all(ln);
        let _ = w.write_all(b"\n");
        printed_ctx_upto = i as isize;
        // context after
        if o.after > 0 {
            let end = (i + o.after + 1).min(lines.len());
            for j in (i + 1)..end {
                write_context(w, name, j + 1, lines[j], show_name, show_line);
                printed_ctx_upto = j as isize;
            }
        }
    }
    matches
}

fn write_prefix(w: &mut impl Write, name: &str, lineno: usize, show_name: bool, show_line: bool) {
    if show_name { let _ = write!(w, "{}:", name); }
    if show_line { let _ = write!(w, "{}:", lineno); }
}

fn write_context(w: &mut impl Write, name: &str, lineno: usize, ln: &[u8], show_name: bool, show_line: bool) {
    if show_name { let _ = write!(w, "{}-", name); }
    if show_line { let _ = write!(w, "{}-", lineno); }
    let _ = w.write_all(ln);
    let _ = w.write_all(b"\n");
}

// ripgrep --json: one JSON object per line (match + minimal fields opencode reads).
fn emit_json_match(w: &mut impl Write, name: &str, lineno: usize, ln: &[u8], re: &Regex) {
    let line_text = String::from_utf8_lossy(ln);
    let mut subs = String::new();
    for (k, m) in re.find_iter(ln).enumerate() {
        if k > 0 { subs.push(','); }
        let mt = String::from_utf8_lossy(&ln[m.start()..m.end()]);
        subs.push_str(&format!(
            r#"{{"match":{{"text":{}}},"start":{},"end":{}}}"#,
            json_str(&mt), m.start(), m.end()
        ));
    }
    let _ = writeln!(
        w,
        r#"{{"type":"match","data":{{"path":{{"text":{}}},"lines":{{"text":{}}},"line_number":{},"absolute_offset":0,"submatches":[{}]}}}}"#,
        json_str(name), json_str(&(line_text.to_string() + "\n")), lineno, subs
    );
}

fn json_str(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

fn split_lines(data: &[u8]) -> Vec<&[u8]> {
    let mut lines = Vec::new();
    let mut start = 0;
    for (i, &b) in data.iter().enumerate() {
        if b == b'\n' {
            let mut end = i;
            if end > start && data[end - 1] == b'\r' { end -= 1; }
            lines.push(&data[start..end]);
            start = i + 1;
        }
    }
    if start < data.len() {
        lines.push(&data[start..]);
    }
    lines
}

fn display_path(p: &str) -> String {
    p.strip_prefix("./").unwrap_or(p).to_string()
}
