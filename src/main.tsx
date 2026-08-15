import {StrictMode} from "react";
import {createRoot} from "react-dom/client";
import {Agentation} from "agentation";

const root = document.getElementById("app");

if (!root) {
	throw new Error("Root element not found");
}

createRoot(root).render(
	<StrictMode>
		<div>YepNope</div>
		{import.meta.env.DEV && <Agentation />}
	</StrictMode>,
);
