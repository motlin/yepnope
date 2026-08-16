import {defineConfig} from "drizzle-kit";

export default defineConfig({
	dialect: "sqlite",
	schema: "./worker/db/d1-schema.ts",
	out: "./worker/migrations/d1",
});
