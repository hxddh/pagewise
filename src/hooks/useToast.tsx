import { createContext, useCallback, useContext, useState, type ReactNode } from "react";

export interface Toast {
  id: string;
  message: string;
  tone?: "default" | "success" | "error";
}

interface ToastContextValue {
  toasts: Toast[];
  showToast: (message: string, tone?: Toast["tone"]) => void;
  dismissToast: (id: string) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const dismissToast = useCallback((id: string) => {
    setToasts((t) => t.filter((x) => x.id !== id));
  }, []);

  const showToast = useCallback(
    (message: string, tone: Toast["tone"] = "default") => {
      const id = crypto.randomUUID();
      setToasts((t) => [...t, { id, message, tone }]);
      window.setTimeout(() => dismissToast(id), 3200);
    },
    [dismissToast],
  );

  return (
    <ToastContext.Provider value={{ toasts, showToast, dismissToast }}>
      {children}
    </ToastContext.Provider>
  );
}

export function useToast() {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error("useToast must be used within ToastProvider");
  return ctx;
}
