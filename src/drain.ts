import { App, Notice, TAbstractFile, TFile, TFolder, moment } from "obsidian";
import type { Moment } from "moment";
import {
	appHasDailyNotesPluginLoaded,
	createDailyNote,
	getAllDailyNotes,
	getDailyNote,
	getDailyNoteSettings,
} from "obsidian-daily-notes-interface";

import { isCanvasPath, splitCanvas, stringifyCanvas } from "./canvasParser";
import { missingFolders, parentOf } from "./dailyNotePath";
import {
	GateOptions,
	insertIntoSection,
	isProcessableFile,
	splitCompletedBlocks,
	splitLines,
	tidyContent,
} from "./taskParser";
import { isInSourceFolder, isPathExcluded, isSameFile, normalizeVaultPath } from "./exclusions";

/** Format used when the vault's daily-note plugin has no format configured. */
const DEFAULT_DAILY_NOTE_FORMAT = "YYYY-MM-DD";

/**
 * Current date from Obsidian's own bundled moment, so the file name this plugin
 * computes is produced by the very same library the daily-notes core plugin
 * uses. The published typings declare `moment` as `typeof import("moment")`,
 * a namespace object rather than a callable, so the call is unwrapped here
 * once instead of at every use site.
 */
const today = (): Moment => (moment as unknown as () => Moment)();

/** Settings the drain engine needs, mirroring the plugin's data.json. */
export interface DrainSettings extends GateOptions {
	targetHeading: string;
	headingLevel: number;
	sourceFolder: string;
	excludedFolders: string[];
	undoWindowMs: number;
}

/** One file's worth of undo information. */
export interface UndoEntry {
	path: string;
	oldContent: string;
}

/** A single drain run, undoable as a unit. */
export interface UndoRecord {
	entries: UndoEntry[];
	timestamp: number;
}

/** Outcome of draining one file. */
export interface DrainOutcome {
	file: TFile;
	movedCount: number;
}

/** Daily-note settings with the package's defaults applied. */
interface DailyNoteSettings {
	folder: string;
	format: string;
	template: string;
}

export class ConcurrentWriteError extends Error {
	constructor(public readonly path: string) {
		super(`${path} was changed by something else while it was being drained; nothing was moved.`);
		this.name = "ConcurrentWriteError";
	}
}

/**
 * Moves completed task blocks from notes into today's daily note.
 *
 * Every write goes through `Vault.process`, which Obsidian applies as an atomic
 * read-modify-write. The source file additionally gets an optimistic
 * concurrency guard: when its content changed since it was read, nothing is
 * written at all, because overwriting would discard the newer edit.
 */
export class DrainEngine {
	private undoRecord: UndoRecord | null = null;

	constructor(
		private readonly app: App,
		private readonly getSettings: () => DrainSettings,
	) {}

	/**
	 * Today's daily note. The daily-notes core plugin owns the decision about
	 * folder, file name and template; the manual path below only runs when the
	 * core plugin is absent or its folder does not exist yet.
	 */
	async resolveDailyNote(): Promise<TFile> {
		const date = today();
		const settings = this.readDailyNoteSettings();
		const folder = normalizeVaultPath(settings.folder);
		const fileName = date.format(settings.format);
		const path = folder.length === 0 ? fileName : `${folder}/${fileName}`;

		const existing = this.app.vault.getAbstractFileByPath(path);
		if (existing instanceof TFile) return existing;

		// The date format can add sub-folders the core plugin has never seen, e.g.
		// "Journal/2026/10" for a format of "YYYY/MM/YYYY-MM-DD". Those do not
		// exist in a vault that has never seen that month, so the parent chain is
		// created before anything is written. Without this, createDailyNote() and
		// vault.create() both fail on the missing directory.
		await this.ensureFolder(parentOf(path));

		if (appHasDailyNotesPluginLoaded()) {
			try {
				const known = getDailyNote(date, getAllDailyNotes());
				if (known instanceof TFile) return known;

				const created = await createDailyNote(date);
				if (created instanceof TFile) return created;
			} catch (error) {
				console.warn("[Daily Task Drain] daily-notes interface failed, using manual path", error);
			}
		}

		return this.createFromTemplate(path, settings);
	}

	/**
	 * True when a file may be drained: markdown or canvas, inside the source
	 * folder, not excluded, and not the daily note itself.
	 */
	isEligible(file: TFile, dailyNotePath: string | null): boolean {
		const settings = this.getSettings();
		// Canvas files carry Markdown inside their text nodes and are drained
		// through the same gate, so they belong to the same candidate set.
		if (!isProcessableFile(file.path) && !isCanvasPath(file.path)) return false;
		if (dailyNotePath !== null && isSameFile(file.path, dailyNotePath)) return false;
		if (!isInSourceFolder(file.path, settings.sourceFolder)) return false;
		if (isPathExcluded(file.path, settings.excludedFolders)) return false;
		return true;
	}

	/**
	 * Moves every qualifying block of a canvas node set into the daily note.
	 *
	 * A canvas is JSON rather than Markdown, so it takes a different path than
	 * `drainFile`: the gate runs per text node, and the source is written back
	 * as JSON. Both paths share the destination-first ordering and the undo
	 * record, so a canvas drain is undone the same way a note drain is.
	 */
	async drainCanvasFile(file: TFile): Promise<DrainOutcome> {
		const settings = this.getSettings();
		const original = await this.app.vault.read(file);
		const split = splitCanvas(original, settings);

		if (split.completed.length === 0) return { file, movedCount: 0 };

		const dailyNote = await this.resolveDailyNote();
		if (isSameFile(dailyNote.path, file.path)) return { file, movedCount: 0 };

		const targetBefore = await this.app.vault.read(dailyNote);
		const targetAfter = insertIntoSection(
			targetBefore,
			split.completed,
			settings.targetHeading,
			settings.headingLevel,
		);

		const recorded: UndoEntry[] = [{ path: file.path, oldContent: original }];

		if (targetAfter !== targetBefore) {
			await this.app.vault.process(dailyNote, () => targetAfter);
			recorded.push({ path: dailyNote.path, oldContent: targetBefore });
		}

		try {
			await this.writeSource(file, original, stringifyCanvas(split.doc));
		} catch (error) {
			await this.rollback(recorded);
			throw error;
		}

		this.undoRecord = { entries: recorded, timestamp: Date.now() };
		return { file, movedCount: split.changedNodes };
	}

	/**
	 * Dispatches to the markdown or the canvas path depending on the extension.
	 * Both return the same outcome shape, so callers stay free of that branch.
	 */
	async drainAnyFile(file: TFile): Promise<DrainOutcome> {
		if (isCanvasPath(file.path)) return this.drainCanvasFile(file);
		return this.drainFile(file);
	}

	/**
	 * Moves every qualifying block of one file into the daily note. Returns
	 * `movedCount: 0` without touching the disk when nothing qualifies.
	 */
	async drainFile(file: TFile): Promise<DrainOutcome> {
		const settings = this.getSettings();
		const original = await this.app.vault.read(file);
		const { eol } = splitLines(original);
		const split = splitCompletedBlocks(original, settings);

		if (split.completed.length === 0) return { file, movedCount: 0 };

		const dailyNote = await this.resolveDailyNote();
		if (isSameFile(dailyNote.path, file.path)) return { file, movedCount: 0 };

		const targetBefore = await this.app.vault.read(dailyNote);
		const targetAfter = insertIntoSection(
			targetBefore,
			split.completed,
			settings.targetHeading,
			settings.headingLevel,
		);

		// Destination first: should this write fail, the task is still present
		// in the source note instead of having silently disappeared.
		const recorded: UndoEntry[] = [{ path: file.path, oldContent: original }];

		if (targetAfter !== targetBefore) {
			await this.app.vault.process(dailyNote, () => targetAfter);
			recorded.push({ path: dailyNote.path, oldContent: targetBefore });
		}

		try {
			await this.writeSource(file, original, tidyContent(split.remained, eol));
		} catch (error) {
			// Roll the destination back so the task cannot end up in two places.
			await this.rollback(recorded);
			throw error;
		}

		this.undoRecord = { entries: recorded, timestamp: Date.now() };
		return { file, movedCount: split.blocks.length };
	}

	/** Drains every eligible note and canvas in the vault, one file at a time. */
	async drainVault(): Promise<DrainOutcome[]> {
		const dailyNotePath = this.peekDailyNotePath();
		const candidates = this.app.vault
			.getFiles()
			.filter((file): file is TFile => file instanceof TFile)
			.filter((file) => this.isEligible(file, dailyNotePath));

		const outcomes: DrainOutcome[] = [];
		for (const file of candidates) outcomes.push(await this.drainAnyFile(file));

		return outcomes;
	}

	/**
	 * True while the recorded operation can still be undone, used by the command
	 * to explain why nothing happens.
	 */
	canUndo(): boolean {
		const record = this.undoRecord;
		if (record === null) return false;
		return Date.now() - record.timestamp <= this.getSettings().undoWindowMs;
	}

	/** Restores both files of the last drain. Returns false when it expired. */
	async undoLast(): Promise<boolean> {
		const record = this.undoRecord;
		if (record === null) return false;
		if (!this.canUndo()) {
			this.undoRecord = null;
			return false;
		}

		// Oldest first, i.e. the source note before the daily note: should the
		// second write fail, the tasks are then duplicated for a moment instead
		// of being lost.
		for (const entry of record.entries) {
			const file = this.app.vault.getAbstractFileByPath(entry.path);
			if (file instanceof TFile) await this.app.vault.modify(file, entry.oldContent);
		}

		this.undoRecord = null;
		return true;
	}

	/**
	 * Path of today's daily note without creating anything, so the modify event
	 * can be gated before any write happens.
	 */
	peekDailyNotePath(): string | null {
		try {
			const known = getDailyNote(today(), getAllDailyNotes());
			if (known instanceof TFile) return known.path;
		} catch {
			// The daily-notes folder is missing or the plugin is disabled; the
			// settings-derived path below is still the right answer.
		}

		const settings = this.readDailyNoteSettings();
		const folder = normalizeVaultPath(settings.folder);
		const fileName = today().format(settings.format);
		return folder.length === 0 ? fileName : `${folder}/${fileName}`;
	}

	/**
	 * Writes the source note only when it still holds the content this drain was
	 * planned from. Anything else means a concurrent edit that must not be lost.
	 */
	private async writeSource(file: TFile, expected: string, updated: string): Promise<void> {
		let written = false;

		await this.app.vault.process(file, (current) => {
			if (current !== expected) throw new ConcurrentWriteError(file.path);
			written = true;
			return updated;
		});

		if (!written) throw new ConcurrentWriteError(file.path);
	}

	/** Undoes a partially applied drain, used when the source write failed. */
	private async rollback(entries: UndoEntry[]): Promise<void> {
		for (let i = entries.length - 1; i >= 0; i--) {
			const file = this.app.vault.getAbstractFileByPath(entries[i].path);
			if (file instanceof TFile) await this.app.vault.modify(file, entries[i].oldContent);
		}
	}

	private readDailyNoteSettings(): DailyNoteSettings {
		const settings = getDailyNoteSettings() ?? {};
		return {
			folder: (settings.folder ?? "").trim(),
			format: settings.format !== undefined && settings.format.length > 0 ? settings.format : DEFAULT_DAILY_NOTE_FORMAT,
			template: (settings.template ?? "").trim(),
		};
	}

	/** Creates a folder and all missing parents, then returns the deepest one. */
	/**
	 * Creates every folder of `path` that does not exist yet, parents before
	 * children so each createFolder() call has its parent in place.
	 *
	 * `path` is a file path, not a folder: the daily-note path adds sub-folders
	 * from the date format, so "Journal" alone is never enough.
	 */
	private async ensureFolder(path: string): Promise<void> {
		const isFolder = (candidate: string): boolean =>
			this.app.vault.getAbstractFileByPath(candidate) instanceof TFolder;

		const existingPath = this.app.vault.getAbstractFileByPath(parentOf(path));
		if (existingPath !== null && !(existingPath instanceof TFolder)) {
			throw new Error(`${parentOf(path)} exists but is not a folder.`);
		}

		for (const folder of missingFolders(path, isFolder)) {
			const existing: TAbstractFile | null = this.app.vault.getAbstractFileByPath(folder);
			if (existing !== null && !(existing instanceof TFolder)) {
				throw new Error(`${folder} exists but is not a folder.`);
			}
			if (existing === null) await this.app.vault.createFolder(folder);
		}
	}

	/** Last resort: build the daily note from the configured template. */
	private async createFromTemplate(path: string, settings: DailyNoteSettings): Promise<TFile> {
		const template = this.app.vault.getAbstractFileByPath(normalizeVaultPath(settings.template));
		const content =
			template instanceof TFile
				? await this.app.vault.read(template)
				: `# ${today().format(DEFAULT_DAILY_NOTE_FORMAT)}\n`;

		const created = await this.app.vault.create(path, content);
		new Notice(`Daily Task Drain: created today's daily note at ${path}.`);
		return created;
	}
}