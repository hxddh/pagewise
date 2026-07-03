import React from "react";
import ReactDOM from "react-dom/client";
import { applyTheme, loadPreferences, resolveTheme } from "./lib/preferences";
import App from "./App";

void loadPreferences().then((prefs) => applyTheme(resolveTheme(prefs.theme)));

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
