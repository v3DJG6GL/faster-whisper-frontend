#!/usr/bin/env node
// Single source of truth for bumping the app version. The version lives in THREE files
// that can silently drift; this writes all three from one command so a CI release step
// (or a human) never has to touch them by hand:
//
//   node scripts/version.mjs 1.2.3   → write 1.2.3 to package.json, src-tauri/Cargo.toml,
//                                       and src-tauri/tauri.conf.json. A leading "v"
//                                       (e.g. from a git tag "v1.2.3") is accepted/stripped.
//   node scripts/version.mjs --check → assert all three already agree; exit 1 if not
//                                       (use as a CI guard / pre-commit hook).
//   node scripts/version.mjs         → print the current version (the authoritative one,
//                                       tauri.conf.json — what the in-app readout reports).
//
// NOTE: changing Cargo.toml's version means the next `cargo build`/`cargo check`
// regenerates Cargo.lock — run one (CI already builds) so the lockfile lands in the commit.

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PKG = join(ROOT, "package.json");
const CARGO = join(ROOT, "src-tauri", "Cargo.toml");
const TAURI = join(ROOT, "src-tauri", "tauri.conf.json");

// --- readers -------------------------------------------------------------------------
// First top-level `"version": "..."` — dependency entries are keyed by package name,
// never a bare "version" key, so the first match is the package's own version.
const readJsonVersion = (p) => readFileSync(p, "utf8").match(/"version":\s*"([^"]*)"/)?.[1] ?? null;

// The `version = "..."` line inside the [package] table (not a dependency's version).
const readCargoVersion = (p) => {
  let inPkg = false;
  for (const line of readFileSync(p, "utf8").split("\n")) {
    const s = line.trim();
    if (s.startsWith("[")) inPkg = s === "[package]";
    else if (inPkg) {
      const m = s.match(/^version\s*=\s*"([^"]*)"/);
      if (m) return m[1];
    }
  }
  return null;
};

// tauri.conf.json is the authoritative one for the in-app readout, so list it first.
const FILES = [
  { path: TAURI, label: "tauri.conf.json", read: readJsonVersion, write: writeJsonVersion },
  { path: CARGO, label: "Cargo.toml", read: readCargoVersion, write: writeCargoVersion },
  { path: PKG, label: "package.json", read: readJsonVersion, write: writeJsonVersion },
];

// --- writers (targeted single-line edits to keep the diff minimal) --------------------
function writeJsonVersion(p, v) {
  const src = readFileSync(p, "utf8");
  const re = /("version":\s*")[^"]*(")/; // first match = top-level
  // Test the regex, don't compare before/after content: replacing the version with the SAME value
  // yields a byte-identical string, so an `out === src` guard would mis-fire "no version found" on
  // an idempotent re-set — and, since tauri.conf.json is written first, abort mid-loop leaving
  // Cargo.toml + package.json unwritten (the very drift this script prevents). Mirrors writeCargoVersion.
  if (!re.test(src)) throw new Error(`no top-level "version" found in ${p}`);
  writeFileSync(p, src.replace(re, `$1${v}$2`));
}

function writeCargoVersion(p, v) {
  const lines = readFileSync(p, "utf8").split("\n");
  let inPkg = false, done = false;
  for (let i = 0; i < lines.length; i++) {
    const s = lines[i].trim();
    if (s.startsWith("[")) inPkg = s === "[package]";
    else if (inPkg && !done && /^version\s*=\s*"[^"]*"/.test(s)) {
      lines[i] = lines[i].replace(/(version\s*=\s*")[^"]*(")/, `$1${v}$2`);
      done = true;
    }
  }
  if (!done) throw new Error(`no [package] version found in ${p}`);
  writeFileSync(p, lines.join("\n"));
}

// --- cli -----------------------------------------------------------------------------
const arg = process.argv[2];

if (arg === "--check") {
  const found = FILES.map((f) => ({ ...f, v: f.read(f.path) }));
  for (const f of found) console.log(`  ${(f.v ?? "(none)").padEnd(12)} ${f.label}`);
  const distinct = [...new Set(found.map((f) => f.v))];
  if (distinct.length !== 1 || distinct[0] == null) {
    console.error("✗ version mismatch — run: pnpm set-version <x.y.z>");
    process.exit(1);
  }
  console.log(`✓ all three agree: ${distinct[0]}`);
} else if (!arg) {
  console.log(readJsonVersion(TAURI) ?? "(none)");
} else {
  const v = arg.replace(/^v/, ""); // accept a git tag like "v1.2.3"
  if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/.test(v)) {
    console.error(`✗ not a semver version: "${arg}"`);
    process.exit(1);
  }
  for (const f of FILES) f.write(f.path, v);
  console.log(`✓ set version ${v} in: ${FILES.map((f) => f.label).join(", ")}`);
  console.log("  (run a cargo build so Cargo.lock picks up the new version before committing)");
}
