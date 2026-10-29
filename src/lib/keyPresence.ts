export type KeyPresenceState = "present" | "absent" | "unreadable";

export interface KeyPresenceRow {
  label: string;
  state: KeyPresenceState;
}

export interface KeyPresenceInput {
  hasKey: boolean;
  keyState?: "present" | "absent" | "unreadable" | null;
  hasToken: boolean;
  hasOpenalexKey: boolean;
  hasS2Key: boolean;
}

function flag(on: boolean): KeyPresenceState {
  return on ? "present" : "absent";
}

export function keyPresence(input: KeyPresenceInput): KeyPresenceRow[] {
  const ai: KeyPresenceState = input.keyState === "unreadable" ? "unreadable" : flag(input.hasKey);
  return [
    { label: "AI Key", state: ai },
    { label: "MinerU Token", state: flag(input.hasToken) },
    { label: "OpenAlex Key", state: flag(input.hasOpenalexKey) },
    { label: "Semantic Scholar Key", state: flag(input.hasS2Key) },
  ];
}
