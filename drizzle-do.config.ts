import {defineConfig} from "drizzle-kit";

export default defineConfig({
	dialect: "sqlite",
	driver: "durable-sqlite",
	schema: "./worker/db/do-schema.ts",
	out: "./worker/migrations/do",
});
