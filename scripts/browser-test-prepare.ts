import {prepareBrowserTests} from "./browser-test-harness.ts";

// 🧱 The prerequisite step of the local browser suite. It runs ahead of Playwright, with no
// start-up timeout above it, so a cold `vp build` cannot make the suite fail by timing out.
prepareBrowserTests();
