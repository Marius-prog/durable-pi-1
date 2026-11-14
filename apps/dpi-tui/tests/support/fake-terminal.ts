// Replaces ProcessTerminal's I/O so the real App (and its TuiAltScreen layout) runs without a TTY:
// keys go in through `type()`, what the TUI draws is collected in `writes`. `app.ts` builds its terminal with
// `new ProcessTerminal()`, so patching the prototype needs no change to the source.
import { ProcessTerminal } from "@earendil-works/pi-tui";

const proto = ProcessTerminal.prototype as unknown as Record<string, unknown>;
const noop = () => {};

export interface FakeTerminal {
  writes: string[];
  columns: number;
  rows: number;
  /** Send raw key input (for example "\r", "\x03", "\x1b[Z") to the TUI as the terminal would. */
  type(data: string): void;
  /** Everything drawn so far with escape sequences removed. */
  screen(): string;
  restore(): void;
}

const CSI = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;
const OSC = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
export const strip = (s: string) => s.replace(OSC, "").replace(CSI, "");

export function installFakeTerminal(size = { columns: 100, rows: 30 }): FakeTerminal {
  const saved = new Map<string, PropertyDescriptor | undefined>();
  const patch = (name: string, descriptor: PropertyDescriptor) => {
    if (!saved.has(name)) saved.set(name, Object.getOwnPropertyDescriptor(proto, name));
    Object.defineProperty(proto, name, { configurable: true, ...descriptor });
  };
  let onInput: ((data: string) => void) | undefined;
  const fake: FakeTerminal = {
    writes: [],
    columns: size.columns,
    rows: size.rows,
    type: (data) => {
      if (!onInput) throw new Error("the TUI has not started");
      onInput(data);
    },
    screen: () => strip(fake.writes.join("")),
    restore: () => {
      for (const [name, descriptor] of saved) {
        if (descriptor) Object.defineProperty(proto, name, descriptor);
        else delete proto[name];
      }
    },
  };
  patch("start", { value: (input: (data: string) => void) => void (onInput = input) });
  patch("stop", { value: () => void (onInput = undefined) });
  patch("write", { value: (data: string) => void fake.writes.push(data) });
  patch("drainInput", { value: async () => {} });
  for (const name of ["hideCursor", "showCursor", "clearLine", "clearFromCursor", "clearScreen", "moveBy", "setTitle", "setProgress"])
    patch(name, { value: noop });
  patch("columns", { get: () => fake.columns });
  patch("rows", { get: () => fake.rows });
  patch("kittyProtocolActive", { get: () => false });
  return fake;
}
