const base = { width: 18, height: 18, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round", strokeLinejoin: "round" } as const;

export const IconNewChat = () => (
  <svg {...base} aria-hidden="true"><path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" /></svg>
);
export const IconPencil = () => (
  <svg {...base} width={15} height={15} aria-hidden="true"><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" /></svg>
);
export const IconTrash = () => (
  <svg {...base} width={15} height={15} aria-hidden="true"><path d="M3 6h18" /><path d="M8 6V4h8v2" /><path d="M19 6l-1 14H6L5 6" /></svg>
);
export const IconSend = () => (
  <svg {...base} aria-hidden="true"><path d="M12 19V5" /><path d="m5 12 7-7 7 7" /></svg>
);
export const IconStop = () => (
  <svg width={14} height={14} viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="5" width="14" height="14" rx="2" fill="currentColor" /></svg>
);
export const IconClose = () => (
  <svg {...base} aria-hidden="true"><path d="M18 6 6 18" /><path d="m6 6 12 12" /></svg>
);
export const IconChevronDown = () => (
  <svg {...base} width={15} height={15} aria-hidden="true"><path d="m6 9 6 6 6-6" /></svg>
);
export const IconCopy = () => (
  <svg {...base} width={15} height={15} aria-hidden="true"><rect x="9" y="9" width="13" height="13" rx="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" /></svg>
);
export const IconCheck = () => (
  <svg {...base} width={15} height={15} aria-hidden="true"><path d="M20 6 9 17l-5-5" /></svg>
);
export const IconRefresh = () => (
  <svg {...base} width={15} height={15} aria-hidden="true"><path d="M3 12a9 9 0 0 1 15-6.7L21 8" /><path d="M21 3v5h-5" /><path d="M21 12a9 9 0 0 1-15 6.7L3 16" /><path d="M3 21v-5h5" /></svg>
);
