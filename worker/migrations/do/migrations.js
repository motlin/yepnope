import journal from "./meta/_journal.json";
import m0000 from "./0000_initial-schema.sql";
import m0001 from "./0001_add-batch-git-context.sql";

export default {
	journal,
	migrations: {
		m0000,
		m0001,
	},
};
