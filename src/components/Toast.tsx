/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { createContext, useContext, useState, useCallback } from 'react';
import { CheckCircle2, AlertTriangle, Info, X } from 'lucide-react';

export type ToastType = 'success' | 'error' | 'info';

export interface ToastItem {
  id: string;
  title: string;
  body: string;
  message: string;
  type: ToastType;
  visible: boolean;
}

interface ToastContextType {
  toast: (message: string, type?: ToastType) => void;
  success: (message: string) => void;
  error: (message: string) => void;
  info: (message: string) => void;
}

const ToastContext = createContext<ToastContextType | undefined>(undefined);

// Split a single "message" string into a title + body line so the toast looks
// like a modern card (title on top, supporting copy below). If the caller
// already passed two sentences separated by ":" or ".", we keep them split.
const splitMessage = (raw: string, type: ToastType): { title: string; body: string } => {
  const defaults: Record<ToastType, string> = {
    success: 'Success',
    error: 'Something went wrong',
    info: 'Heads up',
  };
  const msg = (raw || '').trim();
  if (!msg) return { title: defaults[type], body: '' };
  if (msg.includes(':')) {
    const i = msg.indexOf(':');
    const title = msg.slice(0, i).trim();
    const body = msg.slice(i + 1).trim();
    if (title.length > 0 && title.length <= 40 && body.length > 0) return { title, body };
  }
  const periodIdx = msg.indexOf('. ');
  if (periodIdx > 0 && periodIdx <= 38) {
    return { title: msg.slice(0, periodIdx).trim(), body: msg.slice(periodIdx + 1).trim() };
  }
  return { title: defaults[type], body: msg };
};

// Per-type visual theme. Plain class strings only (no inline style objects) so
// the design stays crisp and is trivial to tweak.
const THEME: Record<ToastType, { chip: string; bar: string; glow: string; accent: string }> = {
  success: {
    chip: 'bg-gradient-to-br from-emerald-400 to-green-600',
    bar: 'bg-emerald-500',
    glow: 'shadow-[0_18px_55px_-15px_rgba(16,185,129,0.5)]',
    accent: "before:bg-emerald-500",
  },
  error: {
    chip: 'bg-gradient-to-br from-rose-400 to-red-600',
    bar: 'bg-rose-500',
    glow: 'shadow-[0_18px_55px_-15px_rgba(244,63,94,0.5)]',
    accent: "before:bg-rose-500",
  },
  info: {
    chip: 'bg-gradient-to-br from-sky-400 to-blue-600',
    bar: 'bg-sky-500',
    glow: 'shadow-[0_18px_55px_-15px_rgba(14,165,233,0.5)]',
    accent: "before:bg-sky-500",
  },
};

const ToastItemView = ({ t, onRemove }: { t: ToastItem; onRemove: (id: string) => void }) => {
  const theme = THEME[t.type];
  const Icon = t.type === 'success' ? CheckCircle2 : t.type === 'error' ? AlertTriangle : Info;

  return (
    <div
      role={t.type === 'error' ? 'alert' : 'status'}
      className={`group pointer-events-auto relative flex items-start gap-3 w-full min-w-[300px] max-w-sm overflow-hidden rounded-2xl border border-slate-100/80 bg-white/90 backdrop-blur-xl pl-4 pr-2.5 py-3.5 transform-gpu transition-all duration-500 ease-[cubic-bezier(0.16,1,0.3,1)] before:content-[''] before:absolute before:left-0 before:top-0 before:bottom-0 before:w-1 ${theme.accent} ${theme.glow} ${t.visible ? 'opacity-100 translate-x-0 scale-100' : 'opacity-0 translate-x-10 scale-95'}`}
    >
      <div className={`flex-shrink-0 mt-0.5 grid place-items-center w-9 h-9 rounded-xl text-white shadow-md ring-4 ring-white ${theme.chip}`}>
        <Icon className="w-5 h-5" strokeWidth={2.6} />
      </div>

      <div className="flex-1 min-w-0 pt-0.5">
        <p className="text-[13.5px] font-bold text-slate-900 leading-tight tracking-tight">
          {t.title}
        </p>
        {t.body && (
          <p className="text-[12px] text-slate-500 leading-snug mt-0.5 break-words">
            {t.body}
          </p>
        )}
      </div>

      <button
        type="button"
        onClick={() => onRemove(t.id)}
        aria-label="Dismiss notification"
        className="flex-shrink-0 p-1.5 rounded-lg text-slate-300 hover:text-slate-600 hover:bg-slate-100 transition-all opacity-0 group-hover:opacity-100"
      >
        <X className="w-4 h-4" />
      </button>

      <div className={`absolute bottom-0 left-0 right-0 h-[3px] origin-left ${theme.bar} animate-[qf-toast-bar_3.7s_linear_forwards]`} />
    </div>
  );
};

export const ToastProvider = ({ children }: { children: React.ReactNode }) => {
  const [toasts, setToasts] = useState<ToastItem[]>([]);

  const toast = useCallback((message: string, type: ToastType = 'info') => {
    const id = Math.random().toString(36).substring(2, 9);
    const { title, body } = splitMessage(message, type);
    setToasts((prev) => [...prev, { id, title, body, message, type, visible: false }]);
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        setToasts((prev) => prev.map(t => t.id === id ? { ...t, visible: true } : t));
      });
    });
    setTimeout(() => {
      setToasts((prev) => prev.map(t => t.id === id ? { ...t, visible: false } : t));
    }, 3700);
    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, 4000);
  }, []);

  const success = useCallback((msg: string) => toast(msg, 'success'), [toast]);
  const error = useCallback((msg: string) => toast(msg, 'error'), [toast]);
  const info = useCallback((msg: string) => toast(msg, 'info'), [toast]);

  const removeToast = (id: string) => {
    setToasts((prev) => prev.map(t => t.id === id ? { ...t, visible: false } : t));
    setTimeout(() => setToasts((prev) => prev.filter(t => t.id !== id)), 250);
  };

  return (
    <ToastContext.Provider value={{ toast, success, error, info }}>
      {children}
      <style>{`@keyframes qf-toast-bar{from{transform:scaleX(1)}to{transform:scaleX(0)}}`}</style>
      <div className="fixed bottom-5 right-5 z-[200] flex flex-col-reverse gap-3 max-w-sm w-full font-sans pointer-events-none">
        {toasts.map((t) => (
          <React.Fragment key={t.id}><ToastItemView t={t} onRemove={removeToast} /></React.Fragment>
        ))}
      </div>
    </ToastContext.Provider>
  );
};

export const useToast = () => {
  const context = useContext(ToastContext);
  if (!context) {
    throw new Error('useToast must be used inside a ToastProvider context.');
  }
  return context;
};
