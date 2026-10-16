import { App, Notice, Plugin, PluginSettingTab, Setting, TFile } from "obsidian";

import { DrainEngine, DrainSettings, DrainOutcome } from "./drain";
import { parseFolderList } from "./exclusions";

/** Every persisted setting of the plugin. */
interface PluginSettings extends DrainSettings {
	/** Whether saving a note triggers a drain automatically. */
	autoTrigger: boolean;
}

/** Defaults for every persisted setting. */
const DEFAULT_SETTINGS: PluginSettings = {
	targetHeading: "## Erledigt",
	headingLevel: 2,
	sourceFolder: "",
	excludedFolders: ["Journal/", "Templates/", "099_Archiv/", "AGENT/"],
	requireSubtasksDone: true,
	autoTrigger: true,
	undoWindowMs: 120000,
};

/**
 * Milliseconds the modify handler waits before clearing its re-entry flag.
 * Writing a note makes Obsidian fire `modify` again, and a drain writes twice;
 * without this delay a burst of edits would restart the drain repeatedly.
 */
const REENTRY_RESET_MS = 250;

export default class DailyTaskDrainPlugin extends Plugin {
	settings: PluginSettings = { ...DEFAULT_SETTINGS, excludedFolders: [...DEFAULT_SETTINGS.excludedFolders] };

	private engine!: DrainEngine;
	private isProcessing = false;

	async onload(): Promise<void> {
		await this.loadSettings();

		this.engine = new DrainEngine(this.app, () => this.settings);

		this.registerEvent(
			this.app.vault.on("modify", (changed) => {
				if (!this.settings.autoTrigger || this.isProcessing) return;
				void this.runDrain(async () => {
					if (!(changed instanceof TFile)) return [];
					if (!this.engine.isEligible(changed, this.engine.peekDailyNotePath())) return [];
					return [await this.engine.drainAnyFile(changed)];
				});
			}),
		);

		this.addCommand({
			id: "drain-completed-tasks",
			name: "Drain completed tasks from the current file",
			callback: () => {
				void this.runDrain(async () => {
					const active = this.app.workspace.getActiveFile();
					if (!(active instanceof TFile)) {
						new Notice("Daily Task Drain: no note is open.");
						return [];
					}
					return [await this.engine.drainAnyFile(active)];
				});
			},
		});

		this.addCommand({
			id: "drain-whole-vault",
			name: "Drain completed tasks from the whole vault",
			callback: () => {
				void this.runDrain(() => this.engine.drainVault());
			},
		});

		this.addCommand({
			id: "drain-undo-last-operation",
			name: "Undo the last drain",
			callback: () => {
				void this.runDrain(async () => {
					const undone = await this.engine.undoLast();
					new Notice(
						undone
							? "Daily Task Drain: last drain undone."
							: "Daily Task Drain: nothing left to undo.",
					);
					return [];
				});
			},
		});

		this.addSettingTab(new DailyTaskDrainSettingTab(this.app, this));
	}

	onunload(): void {
		this.isProcessing = false;
	}

	async loadSettings(): Promise<void> {
		const stored = (await this.loadData()) as Partial<PluginSettings> | null;
		this.settings = {
			...DEFAULT_SETTINGS,
			...stored,
			excludedFolders: Array.isArray(stored?.excludedFolders)
				? stored.excludedFolders
				: [...DEFAULT_SETTINGS.excludedFolders],
		};
	}

	/**
	 * Runs a drain with the re-entry guard held for its whole duration. The flag
	 * is cleared on a timer in `finally` rather than immediately, so the modify
	 * events caused by this drain's own writes are ignored.
	 */
	private async runDrain(work: () => Promise<DrainOutcome[]>): Promise<void> {
		if (this.isProcessing) return;
		this.isProcessing = true;

		try {
			const outcomes = await work();
			const moved = outcomes.reduce((sum, outcome) => sum + outcome.movedCount, 0);
			if (moved > 0) {
				new Notice(
					`Daily Task Drain: moved ${moved} task${moved === 1 ? "" : "s"} to today's daily note.`,
				);
			}
		} catch (error) {
			console.error("[Daily Task Drain]", error);
			new Notice(`Daily Task Drain: ${error instanceof Error ? error.message : String(error)}`);
		} finally {
			window.setTimeout(() => {
				this.isProcessing = false;
			}, REENTRY_RESET_MS);
		}
	}
}

/** Settings pane of the plugin. */
class DailyTaskDrainSettingTab extends PluginSettingTab {
	constructor(
		app: App,
		private readonly plugin: DailyTaskDrainPlugin,
	) {
		super(app, plugin);
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		new Setting(containerEl)
			.setName("Target heading")
			.setDesc("Heading in the daily note that completed tasks are appended to.")
			.addText((text) =>
				text
					.setPlaceholder("## Erledigt")
					.setValue(this.plugin.settings.targetHeading)
					.onChange(async (value) => {
						this.plugin.settings.targetHeading = value.trim().length > 0 ? value.trim() : DEFAULT_SETTINGS.targetHeading;
						await this.plugin.saveData(this.plugin.settings);
					}),
			);

		new Setting(containerEl)
			.setName("Heading level")
			.setDesc("Level used when the heading has to be created because the daily note does not have it yet.")
			.addSlider((slider) =>
				slider
					.setLimits(1, 6, 1)
					.setDynamicTooltip()
					.setValue(this.plugin.settings.headingLevel)
					.onChange(async (value) => {
						this.plugin.settings.headingLevel = value;
						await this.plugin.saveData(this.plugin.settings);
					}),
			);

		new Setting(containerEl)
			.setName("Source folder")
			.setDesc("Only notes inside this folder are scanned. Leave empty to scan the whole vault.")
			.addText((text) =>
				text
					.setPlaceholder("Vault root")
					.setValue(this.plugin.settings.sourceFolder)
					.onChange(async (value) => {
						this.plugin.settings.sourceFolder = value.trim();
						await this.plugin.saveData(this.plugin.settings);
					}),
			);

		new Setting(containerEl)
			.setName("Excluded folders")
			.setDesc("One folder per line. Folders and their subfolders are never scanned.")
			.addTextArea((text) =>
				text
					.setPlaceholder(DEFAULT_SETTINGS.excludedFolders.join("\n"))
					.setValue(this.plugin.settings.excludedFolders.join("\n"))
					.onChange(async (value) => {
						this.plugin.settings.excludedFolders = parseFolderList(value);
						await this.plugin.saveData(this.plugin.settings);
					}),
			);

		new Setting(containerEl)
			.setName("Require sub-tasks to be done")
			.setDesc(
				"When on, a task only moves if every sub-task below it is checked too. Turn this off to move parents immediately.",
			)
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.requireSubtasksDone).onChange(async (value) => {
					this.plugin.settings.requireSubtasksDone = value;
					await this.plugin.saveData(this.plugin.settings);
				}),
			);

		new Setting(containerEl)
			.setName("Automatic trigger")
			.setDesc("Drain a note automatically whenever it is saved.")
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.autoTrigger).onChange(async (value) => {
					this.plugin.settings.autoTrigger = value;
					await this.plugin.saveData(this.plugin.settings);
				}),
			);

		new Setting(containerEl)
			.setName("Undo window (ms)")
			.setDesc("How long the last drain can be undone. 120000 ms is two minutes.")
			.addText((text) =>
				text
					.setPlaceholder("120000")
					.setValue(String(this.plugin.settings.undoWindowMs))
					.onChange(async (value) => {
						const parsed = Number.parseInt(value, 10);
						if (!Number.isFinite(parsed) || parsed < 0) return;
						this.plugin.settings.undoWindowMs = parsed;
						await this.plugin.saveData(this.plugin.settings);
					}),
			);
	}
}