import React from 'react';
import { Outlet } from 'react-router';
import { ThemeProvider } from '../theme-context';
import { galaxySunsetTheme } from '../themes';

export function LandingLayout() {
  return (
    <ThemeProvider theme={galaxySunsetTheme}>
      <Outlet />
    </ThemeProvider>
  );
}
