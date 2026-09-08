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

/* ── Rendered catalogue ──────────────────────────────────────────────────── */

/**
 * The index in the root README grows by one row per *subject*, and each subject
 * carries its own deck list. GitHub renders a folder's README when you browse
 * into it, so `subjects/system-design/` shows its decks on the way in — the
 * catalogue scales without the root README ever getting longer than the number
 * of subjects.
 */
const IMPORT_BASE = 'https://stoaflow.com.br/import?path=';
const START = '<!-- catalogue:start -->';
const END = '<!-- catalogue:end -->';
const FEATURED_START = '<!-- featured:start -->';
const FEATURED_END = '<!-- featured:end -->';

const GENERATED_NOTE =
  '<!-- Generated by scripts/build-manifest.mjs. Do not edit by hand. -->';

const escapeCell = (value) => value.replace(/\|/g, '\\|').replace(/\n/g, ' ');

const importLink = (path) => `${IMPORT_BASE}${path}`;

const decksOfSubject = (manifest, subjectSlug) =>
  Object.entries(manifest.decks)
    .filter(([, deck]) => deck.subject === subjectSlug)
    .sort(([, a], [, b]) => a.title.localeCompare(b.title));

/**
 * A rendered page links to the repository by relative path, and the two root
 * READMEs do not sit at the same depth — `README.md` is at the root, its
 * translations are two levels down. Every in-repo link is built from the page's
 * own base so a translation never points at `docs/i18n/subjects/…`.
 */
const ROOT_README_BASE = '.';
const NESTED_README_BASE = '../..';

/**
 * GitHub's markdown sanitiser strips `target`, so a README link cannot open a
 * new tab — verified against its own renderer. The badge is an image inside a
 * plain link for that reason: it buys the button, not the tab.
 */
const addButton = (path, labels, base) =>
  `<a href="${importLink(path)}"><img src="${base}/.github/assets/add-to-stoa.svg" alt="${labels.add}" height="28" /></a>`;

const subjectReadme = (manifest, subjectSlug, subject, labels) => {
  const rows = decksOfSubject(manifest, subjectSlug).map(([path, deck]) => {
    const description = deck.description ? `<br/>${escapeCell(deck.description)}` : '';
    const button = addButton(path, labels, NESTED_README_BASE);
    return `| **${escapeCell(deck.title)}**${description} | ${deck.cardCount} | ${button} |`;
  });

  return [
    GENERATED_NOTE,
    '',
    `# ${escapeCell(subject.title)}`,
    '',
    ...(subject.description ? [escapeCell(subject.description), ''] : []),
    `${subject.deckCount} ${subject.deckCount === 1 ? labels.deck : labels.decks} · [${labels.back}](../../README.md)`,
    '',
    `| ${labels.colDeck} | ${labels.colCards} | |`,
    '| --- | ---: | --- |',
    ...rows,
    '',
    labels.footer,
    '',
  ].join('\n');
};

const catalogueIndex = (manifest, labels, base) => {
  const rows = Object.entries(manifest.subjects)
    .sort(([, a], [, b]) => a.title.localeCompare(b.title))
    .map(([slug, subject]) => {
      const description = subject.description ? escapeCell(subject.description) : '';
      const link = `[**${escapeCell(subject.title)}**](${base}/subjects/${slug}/)`;
      return `| ${link} | ${description} | ${subject.deckCount} |`;
    });

  const total = Object.keys(manifest.decks).length;

  return [
    START,
    GENERATED_NOTE,
    '',
    `| ${labels.colSubject} | | ${labels.colDecks} |`,
    '| --- | --- | ---: |',
    ...rows,
    '',
    `${labels.total(total, rows.length)}`,
    END,
  ].join('\n');
};

/* ── Featured decks — the sample at the top of the root README ────────────── */

const FEATURED_PATH = join(ROOT, 'featured.json');
const FEATURED_COUNT = 3;

/**
 * Which decks open the README is an editorial call, so it is the one thing here
 * that is chosen rather than derived: `featured.json` lists the paths. It is
 * optional — without it the biggest decks stand in, so a fresh clone still
 * renders something true.
 */
const readFeaturedPaths = () => {
  let raw;
  try {
    raw = readFileSync(FEATURED_PATH, 'utf8');
  } catch {
    return { paths: null };
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    return { error: `"featured.json" is not valid JSON: ${cause.message}` };
  }

  if (!Array.isArray(parsed?.decks)) {
    return { error: '"featured.json" must be an object with a "decks" array.' };
  }

  return { paths: parsed.decks };
};

/**
 * A featured path that is not in the manifest would render a button linking to
 * something the API refuses to serve — the one failure a reader meets before
 * anything else. It stops the build instead.
 */
function selectFeatured(manifest) {
  const { paths, error } = readFeaturedPaths();
  if (error) return { featured: [], errors: [error] };

  if (paths === null) {
    const fallback = Object.entries(manifest.decks)
      .sort(([, a], [, b]) => b.cardCount - a.cardCount || a.title.localeCompare(b.title))
      .slice(0, FEATURED_COUNT);
    return { featured: fallback, errors: [] };
  }

  const errors = [];
  const featured = [];

  for (const path of paths.slice(0, FEATURED_COUNT)) {
    const deck = manifest.decks[path];
    if (!deck) {
      errors.push(
        `"featured.json" lists "${path}", which is not a published deck. Fix the path or remove the entry.`,
      );
      continue;
    }
    featured.push([path, deck]);
  }

  return { featured, errors };
}

const featuredBlock = (manifest, featured, labels, base) => {
  const rows = featured.map(([path, deck]) => {
    const description = deck.description ? `<br/>${escapeCell(deck.description)}` : '';
    const link = `[**${escapeCell(deck.title)}**](${base}/subjects/${deck.subject}/)`;
    const button = addButton(path, labels, base);
    return `| ${link}${description} | ${deck.cardCount} | ${button} |`;
  });

  const total = Object.keys(manifest.decks).length;

  return [
    FEATURED_START,
    GENERATED_NOTE,
    '',
    `| ${labels.colDeck} | ${labels.colCards} | |`,
    '| --- | ---: | --- |',
    ...rows,
    '',
    labels.featuredMore(featured.length, total),
    FEATURED_END,
  ].join('\n');
};

const LABELS = {
  en: {
    add: 'Add to Stoa',
    deck: 'deck',
    decks: 'decks',
    back: 'All subjects',
    colDeck: 'Deck',
    colCards: 'Cards',
    colSubject: 'Subject',
    colDecks: 'Decks',
    footer: 'A deck opens in Stoa and shows itself before asking for anything — an account is only needed to keep it.\n\n> [!TIP]\n> 💡 `Middle-click` or `⌘/Ctrl-click` to open it in a new tab.',
    total: (decks, subjects) =>
      `${decks} deck(s) across ${subjects} subject(s). Open a subject to see its decks.`,
    featuredMore: (shown, total) =>
      `${shown} of ${total} decks. **[Browse the full catalogue →](#the-catalogue)**`,
  },
  'pt-BR': {
    add: 'Adicionar ao Stoa',
    deck: 'deck',
    decks: 'decks',
    back: 'Todos os assuntos',
    colDeck: 'Deck',
    colCards: 'Cards',
    colSubject: 'Assunto',
    colDecks: 'Decks',
    footer: 'Abrir um link mostra o deck antes de pedir qualquer coisa — a conta só é necessária para guardá-lo.',
    total: (decks, subjects) =>
      `${decks} deck(s) em ${subjects} assunto(s). Abra um assunto para ver os decks dele.`,
    featuredMore: (shown, total) =>
      `${shown} de ${total} decks. **[Ver o catálogo completo →](#o-catálogo)**`,
  },
};

const replaceBlock = (file, current, startMarker, endMarker, block) => {
  const start = current.indexOf(startMarker);
  const end = current.indexOf(endMarker);

  if (start === -1 || end === -1) {
    throw new Error(
      `"${file}" has no ${startMarker} / ${endMarker} markers, so the block has nowhere to go.`,
    );
  }

  return current.slice(0, start) + block + current.slice(end + endMarker.length);
};

/**
 * A subject folder that stops publishing keeps its rendered page, which would
 * go on advertising decks that are no longer served. The folder is the author's
 * to delete, so this reports it rather than removing files on its own.
 */
function findOrphanPages(manifest) {
  return listDirectories(SUBJECTS_DIR)
    .filter((slug) => !manifest.subjects[slug])
    .filter((slug) => {
      try {
        readFileSync(join(SUBJECTS_DIR, slug, 'README.md'), 'utf8');
        return true;
      } catch {
        return false;
      }
    })
    .map(
      (slug) =>
        `"subjects/${slug}/README.md" describes a subject that publishes nothing. Delete the folder or fix its decks.`,
    );
}

function renderOutputs(manifest, featured) {
  const outputs = new Map();

  outputs.set(MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`);

  for (const [slug, subject] of Object.entries(manifest.subjects)) {
    outputs.set(
      join(SUBJECTS_DIR, slug, 'README.md'),
      subjectReadme(manifest, slug, subject, LABELS.en),
    );
  }

  for (const [file, labels, base] of [
    [join(ROOT, 'README.md'), LABELS.en, ROOT_README_BASE],
    [join(ROOT, 'docs', 'i18n', 'README.pt-BR.md'), LABELS['pt-BR'], NESTED_README_BASE],
  ]) {
    let content = readFileSync(file, 'utf8');
    content = replaceBlock(file, content, START, END, catalogueIndex(manifest, labels, base));
    content = replaceBlock(
      file,
      content,
      FEATURED_START,
      FEATURED_END,
      featuredBlock(manifest, featured, labels, base),
    );
    outputs.set(file, content);
  }

  return outputs;
}

/* ── Entry point ─────────────────────────────────────────────────────────── */

const { manifest, warnings, errors } = buildManifest();

for (const warning of warnings) console.warn(`warning: ${warning}`);

if (errors.length > 0) {
  for (const error of errors) console.error(`error: ${error}`);
  process.exit(1);
}

const orphans = findOrphanPages(manifest);
if (orphans.length > 0) {
  for (const orphan of orphans) console.error(`error: ${orphan}`);
  process.exit(1);
}

const { featured, errors: featuredErrors } = selectFeatured(manifest);
if (featuredErrors.length > 0) {
  for (const error of featuredErrors) console.error(`error: ${error}`);
  process.exit(1);
}

let outputs;
try {
  outputs = renderOutputs(manifest, featured);
} catch (cause) {
  console.error(`error: ${cause.message}`);
  process.exit(1);
}

const isCheck = process.argv.includes('--check');
const relative = (file) => file.slice(ROOT.length + 1);

const stale = [...outputs].filter(([file, content]) => {
  try {
    return readFileSync(file, 'utf8') !== content;
  } catch {
    return true;
  }
});

const summary = `${Object.keys(manifest.decks).length} deck(s) across ${Object.keys(manifest.subjects).length} subject(s)`;

if (stale.length === 0) {
  console.log(`catalogue is up to date — ${summary}.`);
  process.exit(0);
}

if (isCheck) {
  for (const [file] of stale) console.error(`error: "${relative(file)}" is out of date.`);
  console.error('Run "node scripts/build-manifest.mjs" and commit the result.');
  process.exit(1);
}

for (const [file, content] of stale) {
  writeFileSync(file, content);
  console.log(`rebuilt ${relative(file)}`);
}
console.log(`catalogue rebuilt — ${summary}.`);
