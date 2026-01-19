// ============================================================
// PERSONALITY TEMPLATE
// This file is REPLACED during character creation
// ============================================================

export const SYSTEM_PROMPT = `{{SYSTEM_PROMPT}}`;

export const CHARACTER_INFO = {
  name: '{{DISPLAY_NAME}}',
  occupation: '{{OCCUPATION}}',
  relationship: '{{RELATIONSHIP}}',
  voice_formula: '{{VOICE_FORMULA}}'
};

export function getWelcomePrompt(userName: string, isFirstTime: boolean): string {
  if (isFirstTime) {
    return `
## WELCOME NEW USER
${userName} just clicked your link from the website. This is their FIRST time meeting you.
Send a warm, intriguing opening message that:
- Introduces yourself naturally (not formally)
- Shows your personality immediately
- Invites conversation without being pushy
- Is 2-3 sentences max

Do NOT:
- Say "Welcome!" or sound like a customer service bot
- Explain what you are or how this works
- Be generic - be YOU
`;
  } else {
    return `
## RETURNING USER
${userName} clicked your link again. You've talked before.
Send a casual "hey, you're back" message that:
- Acknowledges you know them
- References something from past conversations if possible
- Is warm but not over-the-top

Keep it to 1-2 sentences.
`;
  }
}

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
