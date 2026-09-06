#!/usr/bin/env node
/**
 * Rebuilds `manifest.json` from what is actually in `subjects/`.
 *
 * The manifest is the catalogue's allowlist: the API resolves a requested path
 * by looking it up as a key under `decks`, and never fetches a path it does not
 * find there. Keeping it generated — rather than hand-edited — is what stops a
 * deck from being published without an entry, or an entry from outliving the
 * CSV it points at.
 *
 * Every field is a pure function of the repository's content. Nothing is read
 * from git metadata: a value that changes when the generated file is committed
 * would make the manifest stale the instant it lands, and `--check` unusable.
 *
 * Usage:
 *   node scripts/build-manifest.mjs           # write manifest.json
 *   node scripts/build-manifest.mjs --check   # fail if it is out of date
 */

import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SUBJECTS_DIR = join(ROOT, 'subjects');
const MANIFEST_PATH = join(ROOT, 'manifest.json');
const MANIFEST_VERSION = 1;

const FRONT_HINTS = ['front', 'question', 'frente', 'pergunta'];
const BACK_HINTS = ['back', 'answer', 'verso', 'resposta'];

/* ── CSV reading — mirrors the API's parser so cardCount never disagrees ── */

const detectDelimiter = (content) => {
  const firstLine = content.split('\n').find((line) => line.trim() !== '');
  return firstLine?.includes(';') ? ';' : ',';
};

const parseRows = (content) => {
  const delimiter = detectDelimiter(content);
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;

  const endField = () => {
    row.push(field);
    field = '';
  };
  const endRow = () => {
    endField();
    rows.push(row);
    row = [];
  };

  for (let index = 0; index < content.length; index += 1) {
    const char = content[index];

    if (quoted) {
      if (char !== '"') field += char;
      else if (content[index + 1] === '"') {
        field += '"';
        index += 1;
      } else quoted = false;
      continue;
    }

    if (char === '"') quoted = true;
    else if (char === delimiter) endField();
    else if (char === '\r') continue;
    else if (char === '\n') endRow();
    else field += char;
  }

  if (field !== '' || row.length > 0) endRow();

  return rows.filter((cells) => cells.some((cell) => cell.trim() !== ''));
};

const matchesHint = (value, hints) =>
  hints.some((hint) => value.toLowerCase().includes(hint));

const looksLikeHeader = (row) =>
  row.length > 0 &&
  row.every((cell) => cell.trim() !== '') &&
  row.some((cell) => matchesHint(cell, FRONT_HINTS) || matchesHint(cell, BACK_HINTS));

/**
 * A comma-separated deck whose answers contain commas parses into more columns
 * than a flashcard has sides, and everything past the first comma is silently
 * dropped. The row still has two filled sides, so nothing else would catch it —
 * which is the whole reason ";" is the recommended separator.
 */
const countExtraColumnRows = (content) => {
  if (detectDelimiter(content) !== ',') return 0;
  return parseRows(content).filter((cells) => cells.length > 2).length;
};

const countCards = (content) => {
  const rows = parseRows(content);
  if (rows.length === 0) return 0;

  const hasHeader = looksLikeHeader(rows[0]);
  const headers = hasHeader ? rows[0] : null;
  const frontIndex = headers
    ? Math.max(headers.findIndex((h) => matchesHint(h, FRONT_HINTS)), 0)
    : 0;
  const backIndex = headers
    ? (() => {
        const found = headers.findIndex((h) => matchesHint(h, BACK_HINTS));
        return found === -1 ? 1 : found;
      })()
    : 1;

  return (hasHeader ? rows.slice(1) : rows).filter(
    (cells) =>
      (cells[frontIndex] ?? '').trim() !== '' && (cells[backIndex] ?? '').trim() !== '',
  ).length;
};

/* ── Repository scanning ─────────────────────────────────────────────────── */

const listDirectories = (path) => {
  try {
    return readdirSync(path).filter((entry) => statSync(join(path, entry)).isDirectory());
  } catch {
    return [];
  }
};

const listCsvFiles = (path) => {
  try {
    return readdirSync(path).filter((entry) => entry.toLowerCase().endsWith('.csv'));
  } catch {
    return [];
  }
};

const titleFromSlug = (slug) =>
  slug
    .split('-')
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');

/**
 * A missing subject.json is normal; a broken one is not. Treating them the same
 * would drop every curated title on a trailing comma and say nothing — the deck
 * would quietly republish under its file name.
 */
const readSubjectMetadata = (subjectSlug) => {
  const file = join(SUBJECTS_DIR, subjectSlug, 'subject.json');

  let raw;
  try {
    raw = readFileSync(file, 'utf8');
  } catch {
    return { metadata: {} };
  }

  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return { error: `"subjects/${subjectSlug}/subject.json" must be a JSON object.` };
    }
    return { metadata: parsed };
  } catch (cause) {
    return {
      error: `"subjects/${subjectSlug}/subject.json" is not valid JSON: ${cause.message}`,
    };
  }
};

const listUnexpectedFiles = (path) => {
  try {
    return readdirSync(path).filter(
      (entry) =>
        !entry.startsWith('.') &&
        !entry.toLowerCase().endsWith('.csv') &&
        statSync(join(path, entry)).isFile(),
    );
  } catch {
    return [];
  }
};

const optionalText = (value) =>
  typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;

function buildManifest() {
  const subjects = {};
  const decks = {};
  const warnings = [];
  const errors = [];

  for (const subjectSlug of listDirectories(SUBJECTS_DIR).sort()) {
    const { metadata = {}, error } = readSubjectMetadata(subjectSlug);
    if (error) {
      errors.push(error);
      continue;
    }

    const deckMetadata =
      typeof metadata.decks === 'object' && metadata.decks !== null ? metadata.decks : {};
    const decksDir = join(SUBJECTS_DIR, subjectSlug, 'decks');
    const files = listCsvFiles(decksDir).sort();

    for (const stray of listUnexpectedFiles(decksDir)) {
      warnings.push(
        `"subjects/${subjectSlug}/decks/${stray}" is not a .csv, so it is never published`,
      );
    }

    if (files.length === 0) {
      warnings.push(`subject "${subjectSlug}" has no deck, so it is not published`);
      continue;
    }

    for (const file of files) {
      const slug = basename(file, '.csv');
      const path = `subjects/${subjectSlug}/decks/${file}`;
      const content = readFileSync(join(decksDir, file), 'utf8');
      const cardCount = countCards(content);
      const truncatedRows = countExtraColumnRows(content);

      if (truncatedRows > 0) {
        warnings.push(
          `"${path}" is comma separated and ${truncatedRows} row(s) split into more than two fields — those answers are being cut at their first comma. Use ";" as the separator.`,
        );
      }

      // A file nobody can study is almost always a mistake — a wrong separator,
      // a header with no rows under it. Skipping it quietly would publish the
      // pull request as green while the deck stays invisible.
      if (cardCount === 0) {
        errors.push(
          `"${path}" holds no usable question and answer pair. Check the separator (";") and that every row has both sides.`,
        );
        continue;
      }

      const curated = deckMetadata[slug] ?? {};

      decks[path] = {
        title: optionalText(curated.title) ?? titleFromSlug(slug),
        ...(optionalText(curated.description)
          ? { description: optionalText(curated.description) }
          : {}),
        subject: subjectSlug,
        slug,
        cardCount,
      };
    }

    const publishedCount = Object.values(decks).filter(
      (deck) => deck.subject === subjectSlug,
    ).length;

    if (publishedCount > 0) {
      subjects[subjectSlug] = {
        title: optionalText(metadata.title) ?? titleFromSlug(subjectSlug),
        ...(optionalText(metadata.description)
          ? { description: optionalText(metadata.description) }
          : {}),
        deckCount: publishedCount,
      };
    }
  }

  return {
    manifest: { version: MANIFEST_VERSION, subjects, decks },
    warnings,
    errors,
  };
}

/* ── Entry point ─────────────────────────────────────────────────────────── */

const { manifest, warnings, errors } = buildManifest();
const serialised = `${JSON.stringify(manifest, null, 2)}\n`;

for (const warning of warnings) console.warn(`warning: ${warning}`);

if (errors.length > 0) {
  for (const error of errors) console.error(`error: ${error}`);
  process.exit(1);
}

const isCheck = process.argv.includes('--check');

let current = null;
try {
  current = readFileSync(MANIFEST_PATH, 'utf8');
} catch {
  current = null;
}

if (current === serialised) {
  console.log(
    `manifest.json is up to date — ${Object.keys(manifest.decks).length} deck(s) across ${Object.keys(manifest.subjects).length} subject(s).`,
  );
  process.exit(0);
}

if (isCheck) {
  console.error(
    'manifest.json is out of date. Run "node scripts/build-manifest.mjs" and commit the result.',
  );
  process.exit(1);
}

writeFileSync(MANIFEST_PATH, serialised);
console.log(
  `manifest.json rebuilt — ${Object.keys(manifest.decks).length} deck(s) across ${Object.keys(manifest.subjects).length} subject(s).`,
);
