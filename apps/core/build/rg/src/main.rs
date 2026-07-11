// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-UEL
// Copyright (C) 2026 And The Next GmbH - https://userland.run
//
// A minimal `rg` for the nano wasm runner (runners/wasm), compiled to
// wasm32-wasip1. Covers `rg --files` — recursive project file enumeration,
// ripgrep's default hidden-skip (which covers .git), and `--glob=!<pat>`
// exclusions — which is the subset the opencode agent needs before its first
// model turn. Search mode (a pattern arg) is a TODO: it needs the upstream
// regex engine and is where "compile ripgrep, don't reimplement" pays off.
//
// std-only (no threads, no mmap) so it compiles cleanly to wasip1.

use std::fs;
use std::path::{Path, PathBuf};

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let mut root = ".".to_string();
    let mut excludes: Vec<String> = Vec::new();
    let mut hidden = false;
    let mut files_mode = false;
    let mut got_path = false;

    for a in args.iter().skip(1) {
        if a == "--files" {
            files_mode = true;
        } else if a == "--hidden" {
            hidden = true;
        } else if let Some(g) = a.strip_prefix("--glob=") {
            if let Some(p) = g.strip_prefix('!') {
                excludes.push(p.to_string());
            }
            // positive globs are ignored in this minimal --files build
        } else if a.starts_with('-') {
            // ignore other ripgrep flags (--no-config, --no-ignore, etc.)
        } else if !got_path {
            root = a.clone();
            got_path = true;
        }
    }

    if !files_mode {
        // Only --files is implemented; a search request is a no-op (exit 0) so
        // opencode's enumeration works and a stray search doesn't error the turn.
        return;
    }

    let base = Path::new(&root);
    let mut files: Vec<String> = Vec::new();
    let mut stack: Vec<PathBuf> = vec![base.to_path_buf()];

    while let Some(dir) = stack.pop() {
        let rd = match fs::read_dir(&dir) {
            Ok(r) => r,
            Err(_) => continue,
        };
        for ent in rd.flatten() {
            let name = ent.file_name().to_string_lossy().into_owned();
            if name == "." || name == ".." {
                continue;
            }
            // ripgrep default: skip hidden entries (covers .git).
            if !hidden && name.starts_with('.') {
                continue;
            }
            let path = ent.path();
            let rel = rel_path(base, &path);
            if excludes.iter().any(|g| glob_match(g, &rel) || glob_match(g, &name)) {
                continue;
            }
            let is_dir = ent.file_type().map(|f| f.is_dir()).unwrap_or(false);
            if is_dir {
                stack.push(path);
            } else {
                files.push(rel);
            }
        }
    }

    files.sort();
    let mut out = String::with_capacity(files.len() * 16);
    for f in &files {
        out.push_str(f);
        out.push('\n');
    }
    print!("{}", out);
}

// Path of `p` relative to `base`, using forward slashes and no leading "./".
fn rel_path(base: &Path, p: &Path) -> String {
    let rel = p.strip_prefix(base).unwrap_or(p);
    let s = rel.to_string_lossy();
    s.trim_start_matches("./").to_string()
}

// A small glob matcher: `**` spans path separators, `*` stays within a segment,
// `?` matches one non-separator char. Enough for `--glob=!**/.git/**`-style
// exclusions without pulling in the globset crate.
fn glob_match(pat: &str, text: &str) -> bool {
    fn m(p: &[u8], t: &[u8]) -> bool {
        if p.is_empty() {
            return t.is_empty();
        }
        match p[0] {
            b'*' if p.len() >= 2 && p[1] == b'*' => {
                let rest = if p.len() >= 3 && p[2] == b'/' { &p[3..] } else { &p[2..] };
                for i in 0..=t.len() {
                    if m(rest, &t[i..]) {
                        return true;
                    }
                }
                false
            }
            b'*' => {
                for i in 0..=t.len() {
                    if m(&p[1..], &t[i..]) {
                        return true;
                    }
                    if i < t.len() && t[i] == b'/' {
                        break;
                    }
                }
                false
            }
            b'?' => !t.is_empty() && t[0] != b'/' && m(&p[1..], &t[1..]),
            c => !t.is_empty() && t[0] == c && m(&p[1..], &t[1..]),
        }
    }
    m(pat.as_bytes(), text.as_bytes())
}
