// Flat line-icon set (stroke-based, 1.8 weight, 24×24 viewBox) replacing the
// emoji glyphs that clashed with the flat UI. One <Icon name="..."/> component
// keeps stroke/size/color consistent everywhere.
import { h, type FunctionalComponent } from 'vue'

const P: Record<string, string[]> = {
  // nav / pages
  bookmark: ['M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z'],
  trash: ['M3 6h18', 'M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2', 'M6 6l1 14a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-14', 'M10 11v6M14 11v6'],
  tag: ['M20.6 13.4l-7.2 7.2a2 2 0 0 1-2.8 0l-7-7A2 2 0 0 1 3 12.2V5a2 2 0 0 1 2-2h7.2a2 2 0 0 1 1.4.6l7 7a2 2 0 0 1 0 2.8z', 'M8.5 8.5h.01'],
  tools: ['M14.7 6.3a4 4 0 0 1-5.4 5.4L4 17v3h3l5.3-5.3a4 4 0 0 0 5.4-5.4l-2 2-2-2z'],
  box: ['M21 8l-9-5-9 5 9 5 9-5z', 'M3 8v8l9 5 9-5V8', 'M12 13v8'],
  settings: ['M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z', 'M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09a1.65 1.65 0 0 0-1.08-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z'],
  // pairing / devices
  link: ['M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7', 'M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7'],
  laptop: ['M4 6a1 1 0 0 1 1-1h14a1 1 0 0 1 1 1v9H4z', 'M2 19h20'],
  phone: ['M8 2h8a1 1 0 0 1 1 1v18a1 1 0 0 1-1 1H8a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1z', 'M11 18h2'],
  // files
  folder: ['M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z'],
  file: ['M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z', 'M14 2v6h6'],
  // actions
  open: ['M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6', 'M15 3h6v6', 'M10 14L21 3'],
  edit: ['M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7', 'M18.5 2.5a2.1 2.1 0 0 1 3 3L12 15l-4 1 1-4z'],
  star: ['M12 17.3L18.2 21l-1.7-7 5.5-4.7-7.2-.6L12 2 9.2 8.6 2 9.3l5.5 4.7-1.7 7z'],
  starOff: ['M12 17.3L18.2 21l-1.7-7 5.5-4.7-7.2-.6L12 2 9.2 8.6 2 9.3l5.5 4.7-1.7 7z', 'M3 3l18 18'],
  move: ['M5 9l-3 3 3 3', 'M9 5l3-3 3 3', 'M15 19l3 3 3-3', 'M19 9l3 3-3 3', 'M2 12h20', 'M12 2v20'],
  copy: ['M9 9h10a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H9a1 1 0 0 1-1-1V10a1 1 0 0 1 1-1z', 'M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1'],
  cut: ['M6 3l12 12', 'M18 3L6 15', 'M6 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6z', 'M18 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6z'],
  paste: ['M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2', 'M9 2h6a1 1 0 0 1 1 1v2a1 1 0 0 1-1 1H9a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1z'],
  plus: ['M12 5v14', 'M5 12h14'],
  check: ['M20 6L9 17l-5-5'],
  close: ['M18 6L6 18', 'M6 6l12 12'],
  search: ['M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16z', 'M21 21l-4.3-4.3'],
  refresh: ['M21 12a9 9 0 1 1-3-6.7', 'M21 3v6h-6'],
  download: ['M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4', 'M7 10l5 5 5-5', 'M12 15V3'],
  upload: ['M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4', 'M17 8l-5-5-5 5', 'M12 3v12'],
  up: ['M12 19V5', 'M5 12l7-7 7 7'],
  chevron: ['M9 18l6-6-6-6'],
  // views
  list: ['M4 6h16', 'M4 12h16', 'M4 18h16'],
  grid: ['M3 3h7v7H3z', 'M14 3h7v7h-7z', 'M3 14h7v7H3z', 'M14 14h7v7h-7z'],
  // misc
  note: ['M4 4h16v12l-4 4H4z', 'M20 16h-4v4'],
  restore: ['M3 12a9 9 0 1 0 9-9 9 9 0 0 0-7.6 4.3', 'M3 3v5h5'],
  shield: ['M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z'],
  globe: ['M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20z', 'M2 12h20', 'M12 2a15 15 0 0 1 0 20 15 15 0 0 1 0-20z'],
  stack: ['M12 2l9 5-9 5-9-5z', 'M3 12l9 5 9-5', 'M3 17l9 5 9-5'],
  palette: ['M12 22a10 10 0 1 1 0-20c5 0 9 3 9 7 0 3-2 4-4 4h-2a2 2 0 0 0-1 3.7c.4.3.7.8.7 1.4A2.9 2.9 0 0 1 12 22z', 'M7.5 10.5h.01M11 7.5h.01M15.5 8.5h.01'],
}

export const Icon: FunctionalComponent<{ name: keyof typeof P | string; size?: number; stroke?: number }> = (props) => {
  const paths = P[props.name as string] || P.file
  const s = props.size ?? 16
  return h(
    'svg',
    {
      width: s, height: s, viewBox: '0 0 24 24', fill: 'none',
      stroke: 'currentColor', 'stroke-width': props.stroke ?? 1.8,
      'stroke-linecap': 'round', 'stroke-linejoin': 'round',
      'aria-hidden': 'true', class: 'md-icon',
    },
    paths.map((d) => h('path', { d })),
  )
}
Icon.displayName = 'MdIcon'
