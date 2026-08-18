import journal from "./meta/_journal.json";
import m0000 from "./0000_initial-schema.sql";
import m0001 from "./0001_add-batch-git-context.sql";
import m0002 from "./0002_previous_bishop.sql";
import m0003 from "./0003_married_korath.sql";
import m0004 from "./0004_brainy_ulik.sql";

export default {
	journal,
	migrations: {
		m0000,
		m0001,
		m0002,
		m0003,
		m0004,
	},
};
