import {useCallback, useEffect, useState} from "react";

// 🌗 One device-local preference decides how YepNope is painted. Light is the palette written on
// bare `:root` in `src/app.css`; dark is the subset of those same tokens redefined on top of it.
// The preference belongs to this browser rather than to the account, so it lives in localStorage
// and never reaches D1 or the Worker.

export type ThemePreference = "dark" | "light" | "system";
export type ResolvedTheme = "dark" | "light";

export const THEME_STORAGE_KEY = "yepnope.theme";

const DARK_SCHEME_QUERY = "(prefers-color-scheme: dark)";

/** Kept in step with `--surface-page` in `src/app.css` and the pre-paint script in `index.html`. */
const THEME_COLORS: Record<ResolvedTheme, string> = {dark: "#17181c", light: "#f1f2f4"};

export interface ThemeChoice {
	label: string;
	preference: ThemePreference;
}

export const THEME_CHOICES: readonly ThemeChoice[] = [
	{label: "Light", preference: "light"},
	{label: "Dark", preference: "dark"},
	{label: "Match system", preference: "system"},
];

function isThemePreference(value: string | null): value is ThemePreference {
	return value === "dark" || value === "light" || value === "system";
}

function storedPreference(): ThemePreference {
	const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
	return isThemePreference(stored) ? stored : "system";
}

function systemTheme(): ResolvedTheme {
	return window.matchMedia(DARK_SCHEME_QUERY).matches ? "dark" : "light";
}

function themeColorMeta(): HTMLMetaElement {
	const existing = document.head.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
	if (existing !== null) {
		return existing;
	}
	const created = document.createElement("meta");
	created.name = "theme-color";
	document.head.append(created);
	return created;
}

/**
 * `data-theme` is written only for an explicit choice, so while the preference is "system" the
 * `prefers-color-scheme` blocks in `app.css` keep deciding on their own — including when the
 * system flips mid-session, with no reload and no repaint from here.
 */
function paint(preference: ThemePreference, resolved: ResolvedTheme): void {
	if (preference === "system") {
		document.documentElement.removeAttribute("data-theme");
	} else {
		document.documentElement.setAttribute("data-theme", preference);
	}
	themeColorMeta().content = THEME_COLORS[resolved];
}

export interface Theme {
	preference: ThemePreference;
	/** What the page is actually painted as right now, for anything CSS cannot reach. */
	resolved: ResolvedTheme;
	select: (preference: ThemePreference) => void;
}

export function useTheme(): Theme {
	const [preference, setPreference] = useState<ThemePreference>(storedPreference);
	const [system, setSystem] = useState<ResolvedTheme>(systemTheme);

	useEffect(() => {
		const query = window.matchMedia(DARK_SCHEME_QUERY);
		function onSchemeChange(event: MediaQueryListEvent): void {
			setSystem(event.matches ? "dark" : "light");
		}
		// A flip between the first render and this subscription fired before anyone was listening,
		// so the current value is read again rather than waited for.
		setSystem(query.matches ? "dark" : "light");
		query.addEventListener("change", onSchemeChange);
		return () => {
			query.removeEventListener("change", onSchemeChange);
		};
	}, []);

	const resolved = preference === "system" ? system : preference;

	useEffect(() => {
		paint(preference, resolved);
	}, [preference, resolved]);

	const select = useCallback((next: ThemePreference): void => {
		window.localStorage.setItem(THEME_STORAGE_KEY, next);
		setPreference(next);
	}, []);

	return {preference, resolved, select};
}
