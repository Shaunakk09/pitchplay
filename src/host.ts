// Where the app is running. PitchPlay runs as a plain static site, and also inside a
// claude.ai hosted page (a sandboxed frame). In that frame, downloads go through the
// host's "downloads" capability, and Web Share, service workers and full screen are refused.

interface Downloads {
  save(req: { filename: string; data: Blob }): Promise<{ status: 'saved' | 'delivered' }>;
}
interface ClaudeHost {
  use(name: string): Promise<unknown>;
}

const claudeHost = (): ClaudeHost | null => {
  try {
    const c = (window as unknown as { claude?: ClaudeHost }).claude;
    return c && typeof c.use === 'function' ? c : null;
  } catch {
    return null;
  }
};

export const inFrame = (): boolean => {
  try {
    return window.self !== window.top;
  } catch {
    return true;
  }
};

// True inside the claude.ai page frame (or any embedding frame).
export const isHosted = (): boolean => !!claudeHost() || inFrame();

let downloadsP: Promise<Downloads | null> | null = null;
const hostDownloads = (): Promise<Downloads | null> => {
  const c = claudeHost();
  if (!c) return Promise.resolve(null);
  downloadsP ??= c.use('downloads').then(
    (d) => (d && typeof (d as Downloads).save === 'function' ? (d as Downloads) : null),
    () => null,
  );
  return downloadsP;
};

// The host accepts only known extensions, so a project file is saved as ".pitchplay.json"
// there. Import accepts both.
const hostName = (name: string) => (/\.pitchplay$/i.test(name) ? `${name}.json` : name);

export type SaveOutcome = 'saved' | 'declined' | 'unavailable';

export async function saveFile(blob: Blob, name: string): Promise<SaveOutcome> {
  const d = await hostDownloads();
  if (d) {
    try {
      await d.save({ filename: hostName(name), data: blob });
      return 'saved';
    } catch (e) {
      const code = (e as { code?: string })?.code;
      return code === 'declined' || code === 'rate_limited' ? 'declined' : 'unavailable';
    }
  }
  if (claudeHost()) return 'unavailable';
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
  return 'saved';
}
