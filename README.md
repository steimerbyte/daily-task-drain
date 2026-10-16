# Daily Task Drain

An Obsidian plugin that moves finished tasks out of your notes and into **today's daily note** — automatically, while you work.

Its defining rule: a task only moves when the task **and every sub-task below it** are done. A half-finished parent stays where it is, together with its children.

---

## Installation

The plugin is not published on the community plugin registry yet. Install it manually:

1. Copy `main.js`, `manifest.json` and `styles.css` into
   `<vault>/.obsidian/plugins/daily-task-drain/`.
2. Enable **Daily Task Drain** under *Settings → Community plugins*.
3. Make sure the core plugin **Daily notes** is enabled, because the plugin takes the daily-note folder, file name format and template from its settings.

To build the plugin from source:

```bash
npm install
npm run build   # writes main.js
npm test        # runs the test suite
```

The suite has four layers, all of which run in `npm test`:

| Layer | What it covers |
| --- | --- |
| Unit | task parsing, the gate, canvas nodes, folder arithmetic, template placeholders |
| Integration | the whole write path against an in-memory vault |
| Regression | replays the duplicate-folder bug that reached the console |
| Vault fixtures | the real files of both vaults, read-only |

The in-memory vault in `tests/harness/fakeVault.ts` is deliberately strict:
`createFolder` throws *Folder already exists* exactly like Obsidian does, which
is what lets the suite catch ordering bugs that a permissive fake would hide.

`npm run dev` starts esbuild in watch mode for development.

---

## What it does

- Watches every Markdown **and canvas** file in the vault via Obsidian's `modify` event.
- Collects all task blocks that satisfy the gate described below.
- Appends them to a heading inside today's daily note.
- Removes them from the note they came from.
- Writes **destination first, source second**, so a failed write can never make a task disappear.

A whole parent block moves as one piece, sub-tasks included, so nothing is ever split off from its parent.

---

## Canvas files

Obsidian canvas files are JSON, not Markdown, so they need their own path. The
plugin applies the same gate to the Markdown inside every `text` node of a
`.canvas` file, so a task on a canvas moves exactly like a task in a note.

Everything else about the canvas is preserved. Only the `text` field of a node
changes; `id`, position, `width`, `height`, `color`, `styleAttributes` and any
plugin-specific keys such as `vn` are written back unchanged, and `edges` and
`metadata` are never touched. A file that is not valid canvas JSON is skipped
rather than rewritten, so a broken file cannot be destroyed.

Two details worth knowing:

- A node that loses all of its content keeps an empty text field. Obsidian draws
  that as an empty box; delete it yourself if you do not want it. The plugin
  never deletes a node, because an edge elsewhere in the canvas may point at it.
- Canvas text is a *fragment* of Markdown, so a node may start in the middle of a
  list. That is exactly why the drain entry point for the current file is called
  "Drain completed tasks from the current file" rather than "from the current
  note".

---

## The gate

```
- [x] Parent
    - [x] Sub A
    - [ ] Sub B
```

This block is **not** moved, because `Sub B` is still open. The same parent with both sub-tasks checked does move.

The gate looks at the task's own checkbox *and* every task line inside its block. Turn off **Require sub-tasks to be done** in the settings to move parents as soon as they themselves are checked.

Details that matter in real vaults:

| Case | Behaviour |
| --- | --- |
| `- [ ]`, `- [x]`, `- [X]` | only `x` and `X` count as done |
| `-`, `*`, `+`, `1.`, `1)` | all are recognised as task bullets |
| Tabs and spaces | both are valid indentation for nesting |
| Tasks in ``` / `~~~` code blocks | never moved, they are documentation |
| Tasks in YAML frontmatter | never moved |
| Headings and `---` breaks | end a task block |
| Canvas `text` nodes | drained with the same gate, node is otherwise left intact |

---

## Where tasks go

The target daily note is **not** computed by this plugin. It reads the real settings of Obsidian's core *Daily notes* plugin (and of *Periodic notes* when that one is in charge) through
[`obsidian-daily-notes-interface`](https://github.com/liamcain/obsidian-daily-notes-interface), so a vault configured as `Journal/YYYY/MM/YYYY-MM-DD.md` gets exactly that note.

Missing folders are created automatically. With the very common configuration
of a folder `Journal` plus a format of `YYYY/MM/YYYY-MM-DD`, a vault that has
never seen the current month has no `Journal/2026/10` yet. The plugin builds the
whole parent chain of the resolved path, parents before children, and only
creates what is actually missing — so an existing `Journal` is never touched
again.

The plugin resolves an **existing** daily note through the core plugin's own
lookup, but creates a **missing** one itself. It deliberately does not call
`createDailyNote()` from `obsidian-daily-notes-interface`: that function calls
`vault.createFolder()` on the whole parent chain guarded only by a truthiness
check, so it re-creates folders that already exist and Obsidian rejects the call
with *Folder already exists*.

A note created by this plugin carries the same template substitutions the core
plugin performs — `{{date}}`, `{{title}}`, `{{time}}`, `{{date+1d}}`,
`{{date-2w:MMMM}}`, `{{yesterday}}`, `{{tomorrow}}` — so the result is
indistinguishable from a note Obsidian created. Unknown placeholders, such as
Templater or Dataview syntax, are left untouched.

Inside the daily note, tasks are appended at the end of a configurable heading (**`## Erledigt`** by default):

- The heading is matched **exactly** after trimming and lower-casing. A substring match would also hit headings like `## Erledigt heute`; this one does not.
- When the daily note has no such heading, it is created at the end of the note with a blank line before and after it, on the configured level.
- The daily note itself is never scanned, which is what stops the plugin from looping on its own writes.

---

## Undo

Every drain records the previous content of **both** touched files. The command **Undo the last drain** restores them.

The record is valid for **120 000 ms (two minutes)** by default; afterwards the command reports that there is nothing to undo. Change the window in the settings.

---

## Commands

| Command | What it does |
| --- | --- |
| Drain completed tasks from the current file | Drains the note or canvas open in the workspace. |
| Drain completed tasks from the whole vault | Walks every eligible Markdown file once. |
| Undo the last drain | Restores both files of the last drain inside the undo window. |

---

## Settings

| Setting | Default | Meaning |
| --- | --- | --- |
| Target heading | `## Erledigt` | Heading in the daily note that receives the tasks. Leading `#` are optional. |
| Heading level | `2` | Level used only when the heading has to be created. |
| Source folder | *(empty)* | Empty scans the whole vault; otherwise only notes inside this folder. |
| Excluded folders | `Journal/`, `Templates/`, `099_Archiv/`, `AGENT/` | One per line, subfolders included. |
| Require sub-tasks to be done | `on` | The core rule. |
| Automatic trigger | `on` | Drain a note when it is saved. |
| Undo window (ms) | `120000` | How long a drain can be undone. |

Folder matching is case-insensitive, normalises `\` to `/`, and matches a folder only as a whole path segment — `Projects` does not exclude `ProjectsArchive`.

---

## Safety

- Every write goes through `Vault.process`, Obsidian's atomic read-modify-write.
- The source file is only written when its content is still the content the drain was planned from. If anything else changed in the meantime, nothing is written and the run is reported as failed — a newer edit is never overwritten.
- The daily note is written **before** the source note. If the daily-note write fails, the task is still present in its original note.
- If the source write fails after the daily note was written, the daily-note write is rolled back so a task cannot end up in two places.
- A re-entry guard stops the modify events caused by the drain's own writes from starting another drain.

---

## Project layout

```
manifest.json          plugin manifest
main.js                build output (generated)
src/main.ts            plugin class, triggers, commands, settings tab
src/taskParser.ts      pure task parsing, block detection, the gate, code-fence mask
src/canvasParser.ts    canvas JSON: finds tasks in text nodes, applies the same gate
src/dailyNotePath.ts   parent-folder arithmetic for the daily note path
src/template.ts        daily-note template placeholders ({{date}}, {{title}}, …)
src/drain.ts           move logic, atomic writes, undo, daily-note resolution
src/exclusions.ts      path matching for source and excluded folders
src/types.d.ts         declarations for Obsidian APIs missing from obsidian.d.ts
tests/                 Jest tests for the pure logic
```

`src/taskParser.ts` and `src/exclusions.ts` import nothing from Obsidian, which is what makes the drain decisions testable in plain Node.

## License

MIT