import journal from "./meta/_journal.json";
import m0000 from "./0000_initial-schema.sql";
import m0001 from "./0001_add-batch-git-context.sql";
import m0002 from "./0002_previous_bishop.sql";

export default {
	journal,
	migrations: {
		m0000,
		m0001,
		m0002,
	},
};
