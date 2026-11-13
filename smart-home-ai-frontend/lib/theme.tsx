'use client'

import { createContext, useContext, useEffect, useState, useCallback } from 'react'

type Theme = 'light' | 'dark'
interface ThemeOptions { persist?: boolean }
interface ThemeCtx {
  theme: Theme
  toggle: () => void
  setTheme: (theme: Theme, options?: ThemeOptions) => void
}

const ThemeContext = createContext<ThemeCtx>({
  theme: 'light',
  toggle: () => {},
  setTheme: () => {},
})

function applyTheme(nextTheme: Theme) {
  document.documentElement.classList.toggle('dark', nextTheme === 'dark')
  document.documentElement.classList.toggle('light', nextTheme === 'light')
}

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [theme, setThemeState] = useState<Theme>('light')

  useEffect(() => {
    applyTheme('light')
  }, [])

  const setTheme = useCallback((nextTheme: Theme, options?: ThemeOptions) => {
    setThemeState(nextTheme)
    applyTheme(nextTheme)

    if (options?.persist !== false) {
      localStorage.setItem('theme', nextTheme)
    }
  }, [])

  const toggle = useCallback(() => {
    setTheme(theme === 'dark' ? 'light' : 'dark')
  }, [setTheme, theme])

  return <ThemeContext.Provider value={{ theme, toggle, setTheme }}>{children}</ThemeContext.Provider>
}

export function useTheme() { return useContext(ThemeContext) }
