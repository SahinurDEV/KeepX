"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { SyncProvider } from "@/components/sync-provider";
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";

interface ToastAction {
  label: string;
  run: () => void;
}

interface ToastItem {
  id: string;
  message: string;
  actions: ToastAction[];
}

interface ToastHandle {
  dismiss: () => void;
}

interface ToastApi {
  push: (message: string, action?: ToastAction | ToastAction[]) => ToastHandle;
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

function canTakeFocus(element: HTMLElement | null): element is HTMLElement {
  if (!element || !document.contains(element)) return false;
  if (element instanceof HTMLButtonElement || element instanceof HTMLInputElement || element instanceof HTMLSelectElement || element instanceof HTMLTextAreaElement) {
    if (element.disabled) return false;
  }
  if (element.getAttribute("aria-disabled") === "true") return false;
  return true;
}

function restoreFocusAfterToast() {
  const stack = document.getElementById("toast-stack");
  const active = document.activeElement;
  if (!stack || !active || !stack.contains(active)) return;
  queueMicrotask(() => {
    const candidates = [
      document.getElementById("sync-status"),
      document.getElementById("appearance-toggle"),
      document.getElementById("content"),
      document.querySelector<HTMLElement>("main"),
    ];
    for (const candidate of candidates) {
      if (!canTakeFocus(candidate)) continue;
      candidate.focus();
      return;
    }
  });
}

export function Providers({ children }: { children: ReactNode }) {
  const [client] = useState(() => new QueryClient({ defaultOptions: { queries: { staleTime: 5_000, retry: 1 } } }));
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const [online, setOnline] = useState(true);
  const toastCount = toasts.length;

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

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || toastCount === 0) return;
      if (event.defaultPrevented) return;
      if (
        [...document.querySelectorAll('[role="dialog"]')].some(
          (el) => el.getAttribute("aria-labelledby") !== "task-detail-title",
        )
      )
        return;
      event.preventDefault();
      event.stopImmediatePropagation();
      restoreFocusAfterToast();
      setToasts((current) => current.slice(0, -1));
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [toastCount]);

  const push = useCallback((message: string, action?: ToastAction | ToastAction[]): ToastHandle => {
    const id = crypto.randomUUID();
    const dismiss = () => {
      restoreFocusAfterToast();
      setToasts((current) => current.filter((toast) => toast.id !== id));
    };
    const raw = action ? (Array.isArray(action) ? action : [action]) : [];
    const actions = raw.map((item) => ({
      label: item.label,
      run: () => {
        dismiss();
        item.run();
      },
    }));
    setToasts((current) => [...current, { id, message, actions }]);
    const ttlMs = actions.some((item) => item.label === "Undo") ? 10_000 : actions.length > 0 ? 8_000 : 6_000;
    window.setTimeout(dismiss, ttlMs);
    return { dismiss };
  }, []);

  const toastApi = useMemo(() => ({ push }), [push]);

  return (
    <QueryClientProvider client={client}>
      <SyncProvider>
      <ToastContext.Provider value={toastApi}>
        <OnlineContext.Provider value={online}>
          {children}
          <div
            id="toast-stack"
            className="pointer-events-none fixed bottom-20 right-4 z-50 flex w-[min(100%-2rem,22rem)] flex-col gap-2 md:bottom-4"
          >
            {toasts.map((toast) => (
              <div key={toast.id} className="pointer-events-auto rounded-lg border border-line bg-surface px-3 py-2 text-sm shadow-lg">
                <button
                  type="button"
                  className="w-full cursor-pointer rounded text-left"
                  aria-label={`Dismiss notice: ${toast.message}`}
                  onClick={() => {
                    restoreFocusAfterToast();
                    setToasts((current) => current.filter((item) => item.id !== toast.id));
                  }}
                >
                  <p role="status">{toast.message}</p>
                </button>
                {toast.actions.length > 0 ? (
                  <div className="mt-1 flex flex-wrap gap-3">
                    {toast.actions.map((action) => (
                      <button
                        key={action.label}
                        className="font-medium text-accent"
                        aria-label={`${action.label}: ${toast.message}`}
                        onClick={() => action.run()}
                        type="button"
                      >
                        {action.label}
                      </button>
                    ))}
                  </div>
                ) : null}
              </div>
            ))}
          </div>
        </OnlineContext.Provider>
      </ToastContext.Provider>
      </SyncProvider>
    </QueryClientProvider>
  );
}
