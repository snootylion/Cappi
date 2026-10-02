/** Ignore acoustic/VAD-only results until Apple Speech has actual words. */
export function isMeaningfulVoiceTranscript(value: string): boolean {
  const normalized = value
    .normalize("NFKC")
    .replace(/^\s*[\[(](?:noise|silence|music|inaudible|unintelligible)[\])]\s*$/i, "")
    .trim();
  return /[\p{L}\p{N}]/u.test(normalized);
}

/** Converts visible Markdown to speech without reading formatting punctuation. */
export function spokenVoiceText(text: string): string {
  return normalizeSpokenText(
    text
      .replace(/\r?\n+/g, " ")
      .replace(/<pi-gui-voice-summary>[\s\S]*?<\/pi-gui-voice-summary>/g, " ")
      .replace(/<pi-gui-live-voice-contract>[\s\S]*?<\/pi-gui-live-voice-contract>/g, " ")
      .replace(/```[\s\S]*?```/g, " ")
      .replace(/`[^`]*`/g, " ")
      .replace(/!\[([^\]]*)\]\([^)]+\)/g, "$1")
      .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
      .replace(/(?:https?:\/\/|www\.)[^\s<>]+/gi, " ")
      .replace(/\b(?:[a-z0-9-]+\.)+(?:com|org|net|io|ai|dev|app|gov|edu|co)(?:\.[a-z]{2})?(?:[\/?#][^\s<>]*)?/gi, " ")
      .replace(/(?:^|\s)(?:\.{0,2}\/|~\/|\/)[^\s,;]+/g, " ")
      .replace(/^#{1,6}\s+/gm, "")
      .replace(/^\s*[-*+]\s+/gm, "")
      .replace(/^\s*\d+[.)]\s+/gm, "")
      .replace(/^\s*>\s?/gm, "")
      .replace(/<\/?[a-z][^>]*>/gi, " ")
      .replace(/[*_~|]/g, " ")
      .replace(/\\([\\`*_[\]{}()#+\-.!>])/g, "$1"),
  );
}

/** Extra cleanup for model-written speech renderings, which should never read UI glyphs or machine paths aloud. */
export function spokenVoiceSummaryText(text: string): string {
  return spokenVoiceText(
    stripStreamingVoiceCode(text)
      .replace(/\b(?:up|down|left|right)(?:ward)?\s+arrow\b\s*[:\-–—]?/giu, " ")
      .replace(/[\u2190-\u21ff\u25a0-\u25ff\u2700-\u27ff\u2900-\u297f]/gu, " ")
      .replace(/\p{Extended_Pictographic}/gu, " ")
      .replace(/["“](?:file:\/\/|~\/|\.{0,2}\/)[^"”]+["”]/giu, " ")
      .replace(/\((?:file:\/\/|~\/|\.{0,2}\/)[^)]+\)/giu, " ")
      .replace(/\[(?:file:\/\/|~\/|\.{0,2}\/)[^\]]+\]/giu, " ")
      .replace(/["'“‘([{<]*\s*(?:file:\/\/|~\/|\.{0,2}\/)[^\s"'”’`<>|)\]}>]+["'”’)\]}>]*/giu, " ")
      .replace(/["'“‘([{<]*\s*[a-z]:\\[^\s"'”’`<>|)\]}>]+["'”’)\]}>]*/giu, " "),
  )
}

/**
 * Removes code before it is complete. A paired-regex cleaner is too late for
 * token streams because diagram/code lines arrive before their closing fence.
 */
export function stripStreamingVoiceCode(value: string): string {
  let result = ""
  let fence: "```" | "~~~" | undefined
  let inlineCode = false
  for (let index = 0; index < value.length;) {
    const marker = value.startsWith("```", index) ? "```" : value.startsWith("~~~", index) ? "~~~" : undefined
    if (marker && (!fence || fence === marker)) {
      fence = fence ? undefined : marker
      if (result && !result.endsWith("\n")) result += "\n"
      index += marker.length
      continue
    }
    const character = value[index] ?? ""
    if (fence) {
      index += 1
      continue
    }
    if (character === "`") {
      inlineCode = !inlineCode
      index += 1
      continue
    }
    if (!inlineCode) result += character
    index += 1
  }
  return result
}

export function extractCompletedVoiceSentences(value: string): { readonly sentences: readonly string[]; readonly remainder: string } {
  const sentences: string[] = [];
  let start = 0;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index] ?? "";
    if (character === "\n") {
      const spoken = spokenVoiceText(value.slice(start, index));
      if (spoken) sentences.push(limitWords(spoken, 80));
      start = index + 1;
      continue;
    }
    if (!".!?".includes(character)) continue;
    if (isInsideWebToken(value, index)) continue;
    const next = value[index + 1];
    if (next !== undefined && !/\s/.test(next)) continue;
    const spoken = spokenVoiceText(value.slice(start, index + 1));
    if (spoken) sentences.push(limitWords(spoken, 80));
    start = index + 1;
  }
  return { sentences, remainder: value.slice(start) };
}

export function flushVoiceFragment(value: string): string {
  return limitWords(spokenVoiceText(value), 80);
}

function isInsideWebToken(value: string, punctuationIndex: number): boolean {
  let tokenStart = punctuationIndex;
  while (tokenStart > 0 && !/\s/.test(value[tokenStart - 1] ?? "")) tokenStart -= 1;
  const token = value.slice(tokenStart, punctuationIndex + 1);
  if (!/^(?:https?:\/\/|www\.)/i.test(token)) return false;
  return value[punctuationIndex] !== "." || value[punctuationIndex + 1] === undefined;
}

function normalizeSpokenText(value: string): string {
  return value.replace(/\s+/g, " ").replace(/\s+([,.;:!?])/g, "$1").trim();
}

function limitWords(value: string, maximum: number): string {
  const words = value.split(/\s+/).filter(Boolean);
  if (words.length <= maximum) return value.trim();
  return `${words.slice(0, maximum).join(" ").replace(/[,:;\-]+$/, "")}.`;
}
