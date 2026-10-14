"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";

interface ToastAction {
  label: string;
  run: () => void;
}

interface ToastItem {
  id: string;
  message: string;
  action?: ToastAction;
}

interface ToastApi {
  push: (message: string, action?: ToastAction) => void;
}

const ToastContext = createContext<ToastApi | null>(null);
const OnlineContext = createContext(true);

export function useToast(): ToastApi {
  const value = useContext(ToastContext);
  if (!value) throw new Error("Toast provider is missing.");
  return value;
}

export function useOnline(): boolean {
  return useContext(OnlineContext);
}

export function Providers({ children }: { children: ReactNode }) {
  const [client] = useState(() => new QueryClient({ defaultOptions: { queries: { staleTime: 5_000, retry: 1 } } }));
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const [online, setOnline] = useState(true);

  useEffect(() => {
    const sync = () => setOnline(navigator.onLine);
    sync();
    window.addEventListener("online", sync);
    window.addEventListener("offline", sync);
    return () => {
      window.removeEventListener("online", sync);
      window.removeEventListener("offline", sync);
    };
  }, []);

  const push = useCallback((message: string, action?: ToastAction) => {
    const id = crypto.randomUUID();
    setToasts((current) => [...current, { id, message, action }]);
    window.setTimeout(() => setToasts((current) => current.filter((item) => item.id !== id)), 6000);
  }, []);

  const toastApi = useMemo(() => ({ push }), [push]);

  return (
    <QueryClientProvider client={client}>
      <ToastContext.Provider value={toastApi}>
        <OnlineContext.Provider value={online}>
          {children}
          <div className="pointer-events-none fixed bottom-20 right-4 z-50 flex w-[min(100%-2rem,22rem)] flex-col gap-2 md:bottom-4">
            {toasts.map((toast) => (
              <div key={toast.id} className="pointer-events-auto rounded-lg border border-line bg-surface px-3 py-2 text-sm shadow-lg">
                <p>{toast.message}</p>
                {toast.action ? (
                  <button className="mt-1 font-medium text-accent" onClick={toast.action.run} type="button">
                    {toast.action.label}
                  </button>
                ) : null}
              </div>
            ))}
          </div>
        </OnlineContext.Provider>
      </ToastContext.Provider>
    </QueryClientProvider>
  );
}
