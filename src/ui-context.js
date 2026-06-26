import { createContext, useContext } from 'react';

// Shared app services handed to every screen: navigation stack control, the
// quit hook, terminal dimensions, and a `setTyping` flag screens raise while a
// text input is focused (so global keys like `q`/Esc don't fire mid-typing).
export const UIContext = createContext(null);

export function useUI() {
  const ctx = useContext(UIContext);
  if (!ctx) throw new Error('useUI must be used within <UIContext.Provider>');
  return ctx;
}
