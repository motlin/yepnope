export interface User {
	id: string;
	name: string;
	email: string;
	createdAt: Date;
	updatedAt: Date;
}

export function createUser(data: Omit<User, "id" | "createdAt" | "updatedAt">): User {
	const now = new Date();
	return {
		...data,
		id: crypto.randomUUID(),
		createdAt: now,
		updatedAt: now,
	};
}

export function validateEmail(email: string): boolean {
	const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
	return emailRegex.test(email);
}

export function updateUser(user: User, updates: Partial<Omit<User, "id" | "createdAt">>): User {
	return {
		...user,
		...updates,
		updatedAt: new Date(),
	};
}
