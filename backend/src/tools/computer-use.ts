import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { mkdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { env } from '../config/env.js';
import { badRequest } from '../shared/app-error.js';

const execFileAsync = promisify(execFile);
export type ComputerAction = { kind: 'screenshot' } | { kind: 'click'; x: number; y: number } | { kind: 'type'; text: string };
export type ComputerResult = { kind: string; screenshotBase64?: string; executed: boolean };

function assertCoordinate(value: number, name: string): void {
  if (!Number.isInteger(value) || value < 0 || value > 20_000) throw badRequest(`${name} must be a screen coordinate`);
}

export function buildComputerPowerShellScript(action: ComputerAction, targetPath?: string): string {
  const base = 'Add-Type -AssemblyName System.Windows.Forms; Add-Type -AssemblyName System.Drawing;';
  if (action.kind === 'screenshot') {
    if (!targetPath) throw new Error('screenshot target path is required');
    const escapedPath = targetPath.replace(/\\/g, '\\\\').replace(/'/g, "''");
    return `${base}$b=New-Object Drawing.Bitmap([Windows.Forms.Screen]::PrimaryScreen.Bounds.Width),([Windows.Forms.Screen]::PrimaryScreen.Bounds.Height);$g=[Drawing.Graphics]::FromImage($b);$g.CopyFromScreen(0,0,0,0,$b.Size);try{$b.Save('${escapedPath}',[Drawing.Imaging.ImageFormat]::Png)}finally{$g.Dispose();$b.Dispose()}`;
  }
  if (action.kind === 'click') {
    assertCoordinate(action.x, 'x');
    assertCoordinate(action.y, 'y');
    return `${base}$bounds=[Windows.Forms.Screen]::PrimaryScreen.Bounds;if(${action.x} -ge $bounds.Width -or ${action.y} -ge $bounds.Height){throw 'coordinates are outside the primary screen'};Add-Type @'\nusing System; using System.Runtime.InteropServices; public static class Mouse { [DllImport("user32.dll")] public static extern bool SetCursorPos(int X,int Y); [DllImport("user32.dll")] public static extern void mouse_event(int f,int dx,int dy,int d,IntPtr e); }\n'@;if(-not [Mouse]::SetCursorPos(${action.x},${action.y})){throw 'cursor movement failed'};[Mouse]::mouse_event(2,0,0,0,[IntPtr]::Zero);[Mouse]::mouse_event(4,0,0,0,[IntPtr]::Zero);`;
  }
  if (action.text.length > 10_000) throw badRequest('text must be at most 10000 characters');
  const encoded = Buffer.from(action.text, 'utf8').toString('base64');
  return `${base}$t=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}'));$t=$t -replace '([+^%~(){}])','{$1}';$t=$t.Replace([char]13,'').Replace([char]10,'{ENTER}');[Windows.Forms.SendKeys]::SendWait($t);`;
}

export type ComputerUseOptions = {
  enabled?: boolean;
  platform?: NodeJS.Platform;
  tempDirectory?: string;
  powershellPath?: string;
  maxScreenshotBytes?: number;
  runPowerShell?: (executable: string, script: string) => Promise<void>;
};

export class ComputerUseService {
  private readonly enabled: boolean;
  private readonly platform: NodeJS.Platform;
  private readonly tempDirectory: string;
  private readonly powershellPath: string;
  private readonly maxScreenshotBytes: number;
  private readonly runPowerShell: (executable: string, script: string) => Promise<void>;

  constructor(options: boolean | ComputerUseOptions = {}) {
    const config = typeof options === 'boolean' ? { enabled: options } : options;
    this.enabled = config.enabled ?? env.computerUseEnabled;
    this.platform = config.platform ?? process.platform;
    this.tempDirectory = path.resolve(config.tempDirectory ?? path.resolve('data', 'computer-use'));
    this.powershellPath = config.powershellPath ?? path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    this.maxScreenshotBytes = config.maxScreenshotBytes ?? 8 * 1024 * 1024;
    if (!Number.isSafeInteger(this.maxScreenshotBytes) || this.maxScreenshotBytes < 1) throw new Error('maxScreenshotBytes must be a positive integer');
    this.runPowerShell = config.runPowerShell ?? (async (executable, script) => {
      await execFileAsync(executable, ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: 30_000 });
    });
  }

  isAvailable(): boolean { return this.platform === 'win32' && this.enabled; }

  async perform(action: ComputerAction): Promise<ComputerResult> {
    if (this.platform !== 'win32') throw new Error('computer use is currently supported on Windows only');
    if (!this.enabled) throw new Error('computer use is disabled. Set COMPUTER_USE_ENABLED=true.');
    if (action.kind === 'click') { assertCoordinate(action.x, 'x'); assertCoordinate(action.y, 'y'); }
    if (action.kind === 'type' && action.text.length > 10_000) throw badRequest('text must be at most 10000 characters');
    const file = action.kind === 'screenshot' ? path.join(this.tempDirectory, `screen-${randomUUID()}.png`) : undefined;
    try {
      if (file) await mkdir(this.tempDirectory, { recursive: true });
      await this.runPowerShell(this.powershellPath, buildComputerPowerShellScript(action, file));
      if (action.kind !== 'screenshot') return { kind: action.kind, executed: true };
      const screenshot = await readFile(file!);
      if (screenshot.byteLength > this.maxScreenshotBytes) throw new Error('screenshot exceeds the configured byte limit');
      return { kind: 'screenshot', screenshotBase64: screenshot.toString('base64'), executed: true };
    } finally {
      if (file) await rm(file, { force: true });
    }
  }
}
