/**
 * Local type declarations for Obsidian APIs that are missing or incomplete in
 * the public `obsidian.d.ts`.
 */

import "obsidian";

declare module "obsidian" {
	interface App {
		/**
		 * Not part of the public API typings: Obsidian exposes the registry of
		 * core plugins here. `obsidian-daily-notes-interface` reads
		 * `internalPlugins.getPluginById("daily-notes").instance.options` through
		 * it to obtain the vault's real daily-note settings, so it must be
		 * declared before the settings are read.
		 */
		internalPlugins: {
			getPluginById(id: string): {
				instance?: {
					options?: Record<string, unknown>;
				};
			} | null;
			getEnabledPluginById?(id: string): unknown;
		};

		}

	/**
	 * `Vault.process` exists at runtime since Obsidian 1.5 but is not declared
	 * in the published typings, so the atomic read-modify-write used for every
	 * file write has to be declared here.
	 */
	interface Vault {
		process(file: TFile, fn: (data: string) => string): Promise<string>;
	}
}

/** Shape of `data.json` as written by this plugin. */
export interface DailyTaskDrainData {
	targetHeading: string;
	headingLevel: number;
	sourceFolder: string;
	excludedFolders: string;
	requireSubtasksDone: boolean;
	autoTrigger: boolean;
	undoWindowMs: number;
}