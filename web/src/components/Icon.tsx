// Inline SVG icons, drawn on a 24 by 24 grid in the text colour. Decorative:
// the words beside an icon always say what it means.

const PATHS = {
  brand: "M3 8a5 5 0 0 1 5-5h8a5 5 0 0 1 5 5v8a5 5 0 0 1-5 5H8a5 5 0 0 1-5-5zM8 12.5l3 3 5-6.5",
  search: "M11 4a7 7 0 1 0 0.01 0zM20 20l-3.5-3.5",
  plus: "M12 5v14M5 12h14",
  user: "M12 4a4 4 0 1 0 0.01 0zM4 21a8 8 0 0 1 16 0",
  "chevron-down": "M6 9l6 6 6-6",
  "chevron-right": "M9 6l6 6-6 6",
  flask: "M9 3h6M10 3v6L4.5 18.5A1.7 1.7 0 0 0 6 21h12a1.7 1.7 0 0 0 1.5-2.5L14 9V3M7.5 15h9",
  close: "M6 6l12 12M18 6L6 18",
  menu: "M4 7h16M4 12h16M4 17h16",
  warning: "M12 3l9.5 17h-19zM12 10v4M12 17.5v.5",
  pause: "M9 5v14M15 5v14",
  mail: "M3 7a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2zM3 7l9 6 9-6",
  copy: "M11 9h7a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2h-7a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2zM5 15V5a2 2 0 0 1 2-2h8",
  refresh: "M20 12a8 8 0 1 1-2.3-5.7M20 4v5h-5",
  lock: "M7 11h10a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2zM8 11V8a4 4 0 0 1 8 0v3",
  check: "M5 12.5l4.5 4.5L19 7.5",
  circle: "M12 3a9 9 0 1 0 0.01 0z",
  cross: "M12 3a9 9 0 1 0 0.01 0zM9 9l6 6M15 9l-6 6",
  payment: "M4 12h14M12 6l6 6-6 6",
  email: "M3 6h18v12H3zM3 7l9 6 9-6",
  bank: "M3 10l9-6 9 6M5 10v8M9.5 10v8M14.5 10v8M19 10v8M3 20h18",
  decision: "M12 4v16M6 8h12M6 8l-3 6a3 3 0 0 0 6 0zM18 8l-3 6a3 3 0 0 0 6 0z",
  approval: "M12 3a9 9 0 1 0 0.01 0zM8 12.5l3 3 5-6",
  callback: "M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2z",
  outage: "M12 3a9 9 0 1 0 0.01 0zM10 9v6M14 9v6",
  error: "M12 3a9 9 0 1 0 0.01 0zM12 8v5M12 16v.5",
  closed: "M12 3a9 9 0 1 0 0.01 0zM8 12.5l3 3 5-6",
  message: "M4 5h16v11H8l-4 3z",
} as const;

export type IconName = keyof typeof PATHS;

export function Icon(props: { name: IconName; size?: number; class?: string }) {
  const size: number = props.size ?? 16;
  return (
    <svg
      class={props.class === undefined ? "icon" : `icon ${props.class}`}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="1.8"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d={PATHS[props.name]} />
    </svg>
  );
}
