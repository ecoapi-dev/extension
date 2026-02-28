import { createContext, useContext, ReactNode } from 'react';
import { ThemeColors, purpleTheme } from './themes';

const ThemeContext = createContext<ThemeColors>(purpleTheme);

export function ThemeProvider({ theme, children }: { theme: ThemeColors; children: ReactNode }) {
  return <ThemeContext.Provider value={theme}>{children}</ThemeContext.Provider>;
}

export function useTheme() {
  return useContext(ThemeContext);
}
