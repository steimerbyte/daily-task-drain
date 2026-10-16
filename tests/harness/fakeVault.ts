/**
 * In-memory stand-in for the parts of Obsidian's Vault that this plugin uses.
 *
 * It is deliberately strict: `createFolder` throws the very same
 * "Folder already exists" error that Obsidian raises, because that strictness
 * is what makes this harness able to reproduce the bug that shipped. A fake
 * that silently tolerated a duplicate folder would have hidden it.
 */

export class FakeTAbstractFile {
	constructor(public path: string) {}
}

export class FakeTFile extends FakeTAbstractFile {
	constructor(
		path: string,
		private content: string,
	) {
		super(path);
	}

	get text(): string {
		return this.content;
	}

	setText(value: string): void {
		this.content = value;
	}
}

export class FakeTFolder extends FakeTAbstractFile {}

export class VaultError extends Error {}

/** Mirror of Obsidian's own failure mode for a duplicate folder. */
export class FolderAlreadyExistsError extends VaultError {
	constructor(path: string) {
		super("Folder already exists.");
		this.name = "FolderAlreadyExistsError";
	}
}

export class ParentNotFoundError extends VaultError {
	constructor(path: string) {
		super(`Folder not found: ${path}`);
		this.name = "ParentNotFoundError";
	}
}

export interface VaultOptions {
	/** Paths that start out as folders, e.g. ["Journal", "Journal/2026"]. */
	folders?: string[];
	/** Initial files, keyed by path. */
	files?: Record<string, string>;
}

export class FakeVault {
	/** Every createFolder call, in order. Used to assert we do not duplicate. */
	readonly createFolderCalls: string[] = [];

	private readonly folders = new Map<string, FakeTFolder>();
	private readonly files = new Map<string, FakeTFile>();

	constructor(options: VaultOptions = {}) {
		for (const folder of options.folders ?? []) this.folders.set(folder, new FakeTFolder(folder));
		for (const [path, content] of Object.entries(options.files ?? {})) {
			const parts = path.split("/");
			parts.pop();
			this.ensureParents(parts.join("/"));
			this.files.set(path, new FakeTFile(path, content));
		}
	}

	private ensureParents(parent: string): void {
		const segments = parent.length === 0 ? [] : parent.split("/");
		let current = "";
		for (const segment of segments) {
			current = current.length === 0 ? segment : `${current}/${segment}`;
			if (!this.folders.has(current)) this.folders.set(current, new FakeTFolder(current));
		}
	}

	getAbstractFileByPath(path: string): FakeTAbstractFile | null {
		return this.files.get(path) ?? this.folders.get(path) ?? null;
	}

	/** Obsidian rejects a second createFolder for the same path. */
	async createFolder(path: string): Promise<FakeTFolder> {
		this.createFolderCalls.push(path);

		const parent = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
		if (parent.length > 0 && !this.folders.has(parent)) {
			throw new ParentNotFoundError(parent);
		}
		if (this.folders.has(path) || this.files.has(path)) {
			throw new FolderAlreadyExistsError(path);
		}

		const folder = new FakeTFolder(path);
		this.folders.set(path, folder);
		return folder;
	}

	/** Obsidian also rejects creating a file whose parent folder is missing. */
	async create(path: string, content: string): Promise<FakeTFile> {
		const parent = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
		if (parent.length > 0 && !this.folders.has(parent)) {
			throw new ParentNotFoundError(parent);
		}
		if (this.files.has(path)) throw new VaultError(`File already exists: ${path}`);

		const file = new FakeTFile(path, content);
		this.files.set(path, file);
		return file;
	}

	async read(file: FakeTFile): Promise<string> {
		return file.text;
	}

	async cachedRead(file: FakeTFile): Promise<string> {
		return file.text;
	}

	async modify(file: FakeTFile, content: string): Promise<void> {
		if (!this.files.has(file.path)) throw new VaultError(`File not found: ${file.path}`);
		file.setText(content);
	}

	/** Obsidian's atomic read-modify-write. */
	async process(file: FakeTFile, fn: (current: string) => string): Promise<string> {
		if (!this.files.has(file.path)) throw new VaultError(`File not found: ${file.path}`);
		const next = fn(file.text);
		if (typeof next === "string") file.setText(next);
		return next;
	}

	getFile(path: string): FakeTFile | null {
		return this.files.get(path) ?? null;
	}

	getFolder(path: string): FakeTFolder | null {
		return this.folders.get(path) ?? null;
	}

	has(path: string): boolean {
		return this.files.has(path) || this.folders.has(path);
	}

	allFiles(): FakeTFile[] {
		return [...this.files.values()];
	}
}