import { useCallback, useState } from "react";

/** Mutually exclusive workbench overlays (palette uses its own lock in useAppCommands). */
export function useWorkbenchOverlays(setSettingsOpen: (open: boolean) => void) {
  const [libraryOpen, setLibraryOpen] = useState(false);
  const [clearConfirmOpen, setClearConfirmOpen] = useState(false);

  const openSettings = useCallback(() => {
    setLibraryOpen(false);
    setClearConfirmOpen(false);
    setSettingsOpen(true);
  }, [setSettingsOpen]);

  const closeSettings = useCallback(() => setSettingsOpen(false), [setSettingsOpen]);

  const toggleLibrary = useCallback(() => {
    setSettingsOpen(false);
    setClearConfirmOpen(false);
    setLibraryOpen((open) => !open);
  }, [setSettingsOpen]);

  const closeLibrary = useCallback(() => setLibraryOpen(false), []);

  const openClearConfirm = useCallback(() => {
    setLibraryOpen(false);
    setSettingsOpen(false);
    setClearConfirmOpen(true);
  }, [setSettingsOpen]);

  const closeClearConfirm = useCallback(() => setClearConfirmOpen(false), []);

  return {
    libraryOpen,
    clearConfirmOpen,
    openSettings,
    closeSettings,
    toggleLibrary,
    closeLibrary,
    openClearConfirm,
    closeClearConfirm,
  };
}
