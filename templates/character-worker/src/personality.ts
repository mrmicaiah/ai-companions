// ============================================================
// PERSONALITY TEMPLATE
// This entire file is REPLACED during character creation
// with content from the Character Creation Kit
// ============================================================

export const SYSTEM_PROMPT = `{{SYSTEM_PROMPT}}`;

export const CHARACTER_INFO = {
  name: '{{DISPLAY_NAME}}',
  occupation: '{{OCCUPATION}}',
  relationship: '{{RELATIONSHIP}}',
  voice_formula: '{{VOICE_FORMULA}}'
};

export function getContextualPrompt(context: {
  currentTime: Date;
  isNewSession: boolean;
  previousSessionSummary?: string;
  sessionList?: string;
}): string {
  const timeStr = context.currentTime.toLocaleString('en-US', {
    weekday: 'long',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
    timeZone: '{{TIMEZONE}}'
  });

  let prompt = `\n## CURRENT CONTEXT\nIt's ${timeStr}.\n`;

  if (context.isNewSession && context.previousSessionSummary) {
    prompt += `\nYour last conversation:\n${context.previousSessionSummary}\n`;
  }

  if (context.sessionList) {
    prompt += `\n## PAST SESSIONS\n${context.sessionList}\n`;
  }

  return prompt;
}
