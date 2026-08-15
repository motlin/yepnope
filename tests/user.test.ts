import {describe, it, expect} from "vitest";
import {createUser, validateEmail, updateUser, type User} from "../src/user.js";

describe("User module", () => {
	describe("createUser", () => {
		it("creates a user with generated id and timestamps", () => {
			const userData = {
				name: "John Doe",
				email: "john@example.com",
			};

			const user = createUser(userData);

			expect(user.name).toBe(userData.name);
			expect(user.email).toBe(userData.email);
			expect(user.id).toBeDefined();
			expect(user.id).toMatch(/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i);
			expect(user.createdAt).toBeInstanceOf(Date);
			expect(user.updatedAt).toBeInstanceOf(Date);
			expect(user.createdAt.getTime()).toBe(user.updatedAt.getTime());
		});
	});

	describe("validateEmail", () => {
		it("validates correct email addresses", () => {
			expect(validateEmail("user@example.com")).toBe(true);
			expect(validateEmail("test.email@domain.co.uk")).toBe(true);
			expect(validateEmail("name+tag@example.org")).toBe(true);
		});

		it("rejects invalid email addresses", () => {
			expect(validateEmail("invalid")).toBe(false);
			expect(validateEmail("@example.com")).toBe(false);
			expect(validateEmail("user@")).toBe(false);
			expect(validateEmail("user @example.com")).toBe(false);
			expect(validateEmail("")).toBe(false);
		});
	});

	describe("updateUser", () => {
		it("updates user fields and updatedAt timestamp", () => {
			const originalUser: User = {
				id: "123",
				name: "Original Name",
				email: "original@example.com",
				createdAt: new Date("2024-01-01"),
				updatedAt: new Date("2024-01-01"),
			};

			const beforeUpdate = Date.now();
			const updatedUser = updateUser(originalUser, {
				name: "Updated Name",
			});

			expect(updatedUser.id).toBe(originalUser.id);
			expect(updatedUser.name).toBe("Updated Name");
			expect(updatedUser.email).toBe(originalUser.email);
			expect(updatedUser.createdAt).toBe(originalUser.createdAt);
			expect(updatedUser.updatedAt.getTime()).toBeGreaterThanOrEqual(beforeUpdate);
		});

		it("returns new object without mutating original", () => {
			const originalUser: User = {
				id: "123",
				name: "Original",
				email: "test@example.com",
				createdAt: new Date(),
				updatedAt: new Date(),
			};

			const updatedUser = updateUser(originalUser, {name: "Updated"});

			expect(updatedUser).not.toBe(originalUser);
			expect(originalUser.name).toBe("Original");
		});
	});
});
