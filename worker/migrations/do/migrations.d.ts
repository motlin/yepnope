// 🧾 Hand-written types for the drizzle-kit generated migrations.js bundle.
interface MigrationJournal {
	entries: Array<{idx: number; when: number; tag: string; breakpoints: boolean}>;
}

declare const migrationBundle: {
	journal: MigrationJournal;
	migrations: Record<string, string>;
};

export default migrationBundle;
