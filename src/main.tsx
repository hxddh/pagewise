import React from "react";
import ReactDOM from "react-dom/client";
import { installPromiseWithResolversPolyfill } from "./lib/polyfills";
import { I18nProvider, resolveLocale } from "./i18n";
import { applyTheme, loadPreferences, resolveTheme } from "./lib/preferences";
import { ThemeProvider } from "./hooks/useTheme";
import App from "./App";

installPromiseWithResolversPolyfill();

void loadPreferences().then((prefs) => {
  applyTheme(resolveTheme(prefs.theme));
  const locale = resolveLocale(prefs.locale);
  document.documentElement.lang = locale === "zh-CN" ? "zh-CN" : "en";
});

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <I18nProvider>
      <ThemeProvider>
        <App />
      </ThemeProvider>
    </I18nProvider>
  </React.StrictMode>,
);
