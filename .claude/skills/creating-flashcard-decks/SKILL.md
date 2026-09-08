---
name: creating-flashcard-decks
description: Use when creating or extending a flashcard deck in this repository — from a video, an article, a note or a bare topic ("create flashcards about X", "generate a deck on Y", "turn this video into cards"). Defines the CSV format, the question mix, the card limit and where the file must be born.
---

# Creating a flashcard deck

A deck is a CSV at `subjects/<subject>/decks/<slug>.csv`. It is only publishable
once the manifest is rebuilt alongside it — the generator is the source of
truth, never a hand edit to `manifest.json`.

## 1. Decide the subject before writing

The subject decides the folder. Two cases, and only two:

- **It is system design** (distributed systems, architectural trade-offs,
  performance, data, protocols, server runtime) → `subjects/system-design/decks/`.
  Ask nothing, go.
- **It is anything else** → **ask the user** which subject the deck belongs to,
  offering the subjects already under `subjects/` plus the option of a new one.
  Never invent a new subject on your own.

When creating a new subject:

```
subjects/<subject-slug>/
├── subject.json
└── decks/
```

`subject.json` needs `title`, `description` and a `decks` block.

## 2. Name the file in English

**The deck filename is always in English, in kebab-case, `.csv`** — regardless
of the language of the source material or of the cards themselves. The cards are
written in Brazilian Portuguese; the filename is not.

| Topic | File |
| --- | --- |
| Teorema CAP | `cap-theorem.csv` |
| Boas práticas com Git | `git-best-practices.csv` |
| Arquitetura de software | `software-architecture.csv` |
| Microfrontend | `microfrontends.csv` |

Same rule for the subject folder slug (`system-design/`, not
`design-de-sistemas/`). The `title` and `description` in `subject.json` stay in
Portuguese — only the slug on disk is translated.

Keep the name short and descriptive of the topic, not of the source: name it
`react-hooks.csv`, never `video-fulano-react.csv` or `aula-3.csv`.

## 3. Write the cards

**Format — not negotiable:**

- `;` as the separator (prose answers are full of commas; `,` truncates the
  answer at the first one).
- Header row `pergunta;resposta`.
- One card per line, no blank line in the middle, trailing `\n`.
- No quoting around fields unless a field itself contains `;`.

**Limit: 15 cards per deck, maximum.** A topic that does not fit in 15 is two
decks, not one deck of 25.

**Question mix.** Every deck covers all three kinds, in this order in the file
(front-load the conceptual ones — they hold the rest up):

| Kind | What it asks | Example |
| --- | --- | --- |
| Concept | The definition, the distinction, the mechanism | *O que é localidade espacial?* |
| Day to day | The concrete decision someone makes while writing code | *Por que percorrer um array é mais rápido que percorrer uma lista ligada?* |
| Interview | The trade-off, the "why", the common trap | *Adicionar réplicas resolve o bloqueio do event loop?* |

**Style — terse is the main requirement:**

- One idea per card. A card that asks two things cannot be graded honestly, and
  spaced repetition depends on that grade.
- Direct question, no warm-up context.
- Answer carries the essential for memorization: **one to two sentences**. The
  first answers; the second, when present, gives the why or the counterexample.
- Cut "it is important to note", "basically", "in general". If the sentence
  survives without the word, the word goes.
- No lists, no code, no markdown inside an answer.
- Cards are written in Brazilian Portuguese, in the same voice as the decks
  already in the repository — read one before writing.

**Read the neighboring decks of the subject first** and do not repeat a card
that already exists. Overlap between decks is fine when the angle differs; a
literal duplicate is not.

## 4. Register and rebuild

1. Add the deck to the `decks` block of the subject's `subject.json`, with a
   `title` (real capitalization, acronyms uppercase) and a `description` (one
   line saying what the deck covers).
2. Rebuild the catalogue:

   ```sh
   node scripts/build-manifest.mjs
   ```

3. Verify — without this, do not claim it is done:

   ```sh
   node scripts/build-manifest.mjs --check
   ```

   Then check in `manifest.json` that the new deck's `cardCount` matches the
   number of cards written and is `<= 15`. A count lower than expected means a
   malformed row, almost always the wrong separator.

## Mistakes this file exists to prevent

- A deck of 25 cards because "the topic is big".
- An answer written as a paragraph, explaining instead of answering.
- A comma-separated CSV, which publishes half an answer and raises no error.
- A new subject created without asking, or a deck dropped into `system-design`
  because that was the folder that already existed.
- A filename in Portuguese (`boas-praticas-git.csv`) or named after the source
  instead of the topic.
- `manifest.json` edited by hand.
