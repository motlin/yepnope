import {describe, it, expect} from "vitest";
import {add, multiply, divide, greet} from "../src/index.js";

describe("Math functions", () => {
	describe("add", () => {
		it("adds two positive numbers", () => {
			expect(add(2, 3)).toBe(5);
		});

		it("adds negative numbers", () => {
			expect(add(-2, -3)).toBe(-5);
		});

		it("adds zero", () => {
			expect(add(5, 0)).toBe(5);
		});
	});

	describe("multiply", () => {
		it("multiplies two positive numbers", () => {
			expect(multiply(3, 4)).toBe(12);
		});

		it("multiplies by zero", () => {
			expect(multiply(5, 0)).toBe(0);
		});

		it("multiplies negative numbers", () => {
			expect(multiply(-2, -3)).toBe(6);
		});
	});

	describe("divide", () => {
		it("divides two numbers", () => {
			expect(divide(10, 2)).toBe(5);
		});

		it("handles decimal results", () => {
			expect(divide(7, 2)).toBe(3.5);
		});

		it("throws on division by zero", () => {
			expect(() => divide(5, 0)).toThrow("Division by zero");
		});
	});
});

describe("String functions", () => {
	describe("greet", () => {
		it("greets a person by name", () => {
			expect(greet("Alice")).toBe("Hello, Alice!");
		});

		it("handles empty string", () => {
			expect(greet("")).toBe("Hello, !");
		});
	});
});
