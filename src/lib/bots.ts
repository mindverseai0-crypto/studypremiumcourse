// ============================================================================
// Bot student roster — shared by the player UI (avatars) and the bots API
// (LLM personas). Client-safe: pure data only, no SDK imports here.
// ============================================================================

export interface BotPersona {
  name: string;
  /** Used inside the LLM prompt to give each bot a consistent voice. */
  vibe: string;
}

/** Random Indian student names — boys and girls mixed. */
export const BOT_PERSONAS: BotPersona[] = [
  { name: 'Aarav', vibe: 'topper energy, explains with easy analogies, a bit competitive' },
  { name: 'Rohan', vibe: 'funny backbencher, memes and cricket references, but surprisingly sharp' },
  { name: 'Priya', vibe: 'makes notes for everything, asks a lot of doubts, helpful' },
  { name: 'Kabir', vibe: 'NCERT line-by-line type, calm and precise' },
  { name: 'Ananya', vibe: 'NEET aspirant, strong at theory, loves diagrams' },
  { name: 'Vihaan', vibe: 'formula memorizer, exam-strategy obsessed' },
  { name: 'Diya', vibe: 'fast learner, replies first, encourages everyone' },
  { name: 'Ishaan', vibe: 'confused but sincere, asks the doubts everyone is shy to ask' },
  { name: 'Sneha', vibe: 'last-minute revisioner, asks for summaries and tricks' },
  { name: 'Kavya', vibe: 'quiet but always accurate, double-checks answers' },
  { name: 'Aditya', vibe: 'sports fanatic, relates everything to real-life examples' },
  { name: 'Ishita', vibe: 'friendly senior energy, keeps the group motivated' },
  { name: 'Dhruv', vibe: 'gadget nerd, loves shortcuts and hacks' },
  { name: 'Meera', vibe: 'steel-solid basics, patiently explains steps' },
  { name: 'Arjun', vibe: 'previous-year-questions grinder, drops PYQ references' },
  { name: 'Riya', vibe: 'cheerful, uses emojis, hypes the teacher' },
];

export const BOT_NAMES: string[] = BOT_PERSONAS.map((p) => p.name);

const BOT_NAME_SET = new Set(BOT_NAMES);

/** Is this comment author one of the bot students? */
export function isBotName(author: string | null | undefined): boolean {
  if (!author) return false;
  return BOT_NAME_SET.has(author.trim());
}

/** Stable DiceBear seed for a name (keeps the same DP everywhere). */
export function avatarUrlFor(name: string): string {
  return `/api/avatar?seed=${encodeURIComponent(name.trim() || 'Student')}`;
}
