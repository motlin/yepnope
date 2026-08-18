export const MACHINE_TOKEN_PREFIX = "ynp_live_";
export const MACHINE_TOKEN_RANDOM_BYTES = 32;
export const MACHINE_TOKEN_ENCODED_CHARACTERS = 43;
export const MACHINE_TOKEN_REDACTION = "[REDACTED_MACHINE_TOKEN]";

const MACHINE_TOKEN_BODY = `[A-Za-z0-9_-]{${MACHINE_TOKEN_ENCODED_CHARACTERS}}`;

export const MACHINE_TOKEN_PATTERN = new RegExp(`^${MACHINE_TOKEN_PREFIX}${MACHINE_TOKEN_BODY}$`);

export function redactMachineTokens(value: string): string {
	return value.replace(new RegExp(`${MACHINE_TOKEN_PREFIX}${MACHINE_TOKEN_BODY}`, "g"), MACHINE_TOKEN_REDACTION);
}
