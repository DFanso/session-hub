export interface ExecResult {
  code: number;
  stdout: string;
}

export const DEFAULT_TIMEOUT_MS = 10_000;

/** Run a command with an argv array. Never throws on non-zero exit; the caller decides. */
export async function run(
  argv: string[],
  env?: Record<string, string>,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<ExecResult> {
  const proc = Bun.spawn(argv, {
    stdout: "pipe",
    stderr: "ignore",
    stdin: "ignore",
    windowsHide: true,
    timeout: timeoutMs,
    ...(env ? { env: { ...process.env, ...env } } : {}),
  });
  const [stdout, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  return { code, stdout };
}

/** The tool's base name without .exe, for messages: tools run by absolute path. */
function toolName(path: string | undefined): string {
  return (path ?? "").replace(/^.*[\\/]/, "").replace(/\.exe$/i, "");
}

/** Run a command; throw with the command name and exit code only on non-zero exit. */
export async function runChecked(argv: string[]): Promise<ExecResult> {
  const r = await run(argv);
  if (r.code !== 0) throw new Error(`${toolName(argv[0])} failed with exit code ${r.code}`);
  return r;
}
