# Colors & Theming

## Theme System

workstream.ai supports dark, light, and system themes. The toggle cycles dark → light → system → dark.

The theme works by swapping CSS custom properties in `src/index.css`. The `html.light` class overrides Tailwind's gray and accent color scales so that **the same Tailwind classes render correctly in both themes**.

### How It Works

- `bg-gray-950` → dark background in dark mode, white in light mode
- `text-gray-300` → light text in dark mode, dark text in light mode
- Accent scales (cyan, red, amber, green, purple) are similarly inverted

### Rules for Contributors

1. **Use gray-scale classes** (`bg-gray-900`, `text-gray-400`, `border-gray-800`) — these swap automatically via CSS variables.
2. **Never use absolute colors** like `bg-black`, `bg-white`, `bg-black/30`, `bg-white/[0.03]` — these do NOT participate in the theme swap and will look wrong in one theme.
3. **Use accent-scale classes** (`bg-red-900/60`, `text-amber-300`) for status colors — the light theme inverts these scales too.

### Status Colors (Traffic Light)

Status badges use a universal traffic light convention:

| Status | Color | Meaning |
|---|---|---|
| `blocked_on_human` | Red | Stop — needs operator action |
| `needs_decision` | Red | Stop — decision required |
| `in_progress` | Amber | Active — work underway |
| `completed` | Green | Done — work finished |
| `noise` | Gray | Informational — no action needed |

These colors are defined in `src/components/StatusBadge.tsx` (fleet table, cards) and `src/components/stream/StatusSnapshot.tsx` (stream detail pane).

### Action Button Colors

| Action | Color | Class prefix |
|---|---|---|
| Unblock | Cyan | `bg-cyan-700` |
| Done | Green | `bg-green-800` |
| Dismiss | Gray | `bg-gray-700` |
| Snooze | Amber | `bg-amber-800` |
| Create Ticket | Purple | `bg-purple-800` |

### Files

- `src/index.css` — CSS variable overrides for light theme
- `src/lib/theme.ts` — Theme state management (`useTheme` hook)
- `src/components/StatusBadge.tsx` — Shared status badge component
