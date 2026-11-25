// Theme system: four curated palettes driven by CSS custom properties on
// <html data-theme="...">. Colors follow established palette guidance
// (indigo family, teal family, neutral dark, warm amber) — each theme
// defines the full token set; nothing else in the app may hardcode hex.
export type ThemeId = 'indigo' | 'teal' | 'dark' | 'amber'

export interface ThemeDef {
  id: ThemeId
  label: string
  swatch: string // two-stop gradient for the picker button
}

export const THEMES: ThemeDef[] = [
  { id: 'indigo', label: '靖紫', swatch: 'linear-gradient(135deg,#5b67f2,#8b5cf6)' },
  { id: 'teal', label: '青蓝', swatch: 'linear-gradient(135deg,#0e9488,#0891b2)' },
  { id: 'dark', label: '暗夜', swatch: 'linear-gradient(135deg,#6366f1,#312e81)' },
  { id: 'amber', label: '琥珀', swatch: 'linear-gradient(135deg,#d97706,#f59e0b)' },
]

const KEY = 'md-theme'

export function currentTheme(): ThemeId {
  const t = localStorage.getItem(KEY) as ThemeId | null
  return t && THEMES.some((x) => x.id === t) ? t : 'indigo'
}

export function applyTheme(id: ThemeId) {
  document.documentElement.setAttribute('data-theme', id)
  localStorage.setItem(KEY, id)
}

export function initTheme() {
  applyTheme(currentTheme())
}
