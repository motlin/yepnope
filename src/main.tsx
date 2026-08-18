import {StrictMode} from "react";
import {createRoot} from "react-dom/client";
import {Agentation} from "agentation";
import {App} from "./app";
import {initializeApplicationUpdates} from "./application-updates";
import "./app.css";

void initializeApplicationUpdates();

const root = document.getElementById("app");

if (!root) {
	throw new Error("Root element not found");
}

createRoot(root).render(
	<StrictMode>
		<App />
		{import.meta.env.DEV && <Agentation />}
	</StrictMode>,
);
