import { Buffer } from "node:buffer";

/**
 * The most input a key is ever read with; a router key is 41 bytes, so 4 KiB
 * leaves room for paste accidents while capping anything unbounded.
 */
export const MAX_INPUT_BYTES = 4096;

/** stdin ended, errored, or hung up while the key was being read. */
export class StdinClosedError extends Error {
  constructor() {
    super("stdin closed");
    this.name = "StdinClosedError";
  }
}

/** More than MAX_INPUT_BYTES arrived; nothing about the input is echoed. */
export class InputTooLongError extends Error {
  constructor() {
    super("input too long for a router key");
    this.name = "InputTooLongError";
  }
}

/**
 * Minimal event-emitting stream surface login reads from. Real stdin and the
 * test fakes (plain EventEmitters) both satisfy it.
 */
export interface ReadableLike {
  on(event: "data", listener: (chunk: Buffer | string) => void): void;
  on(event: "end", listener: () => void): void;
  on(event: "error", listener: (err: Error) => void): void;
  removeListener(event: "data", listener: (chunk: Buffer | string) => void): void;
  removeListener(event: "end", listener: () => void): void;
  removeListener(event: "error", listener: (err: Error) => void): void;
}

/** A readable stream that can be switched into (and out of) raw mode. */
export interface TtyStdin extends ReadableLike {
  setRawMode(mode: boolean): void;
}

/** The stdin surface runLogin wires up: the reader streams plus TTY detection. */
export type StdinLike = ReadableLike & { readonly isTTY?: boolean };

/**
 * Reads one line with echo off: the prompt goes to `write`, typed characters go
 * nowhere. Enter submits; Ctrl-C resolves undefined, which the caller maps to
 * exit code 130; Ctrl-U clears the line; every other control byte is ignored.
 * Raw mode is taken BEFORE the prompt is written, so nothing can echo in the
 * gap. A stream 'end'/'error' — or SIGHUP — restores the terminal and rejects
 * with StdinClosedError, which the caller maps to exit 1; more than
 * MAX_INPUT_BYTES rejects with InputTooLongError (exit 64).
 */
export function readSecret(
  input: TtyStdin,
  write: (text: string) => void,
  prompt: string,
): Promise<string | undefined> {
  return new Promise((resolve, reject) => {
    const decoder = new TextDecoder("utf-8");
    let line = "";
    let lineBytes = 0;
    let settled = false;
    const finish = (settle: () => void) => {
      if (settled) {
        return;
      }
      settled = true;
      input.removeListener("data", onData);
      input.removeListener("end", onClose);
      input.removeListener("error", onClose);
      process.removeListener("SIGHUP", onClose);
      input.setRawMode(false);
      settle();
    };
    const onData = (chunk: Buffer | string) => {
      const bytes = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
      // Stream mode keeps a code point split across chunks intact.
      const text = decoder.decode(bytes, { stream: true });
      for (const char of text) {
        const code = char.codePointAt(0) ?? 0;
        if (code === 0x03) {
          // Ctrl-C
          write("\n");
          finish(() => resolve(undefined));
          return;
        }
        if (code === 0x0d || code === 0x0a) {
          // Enter
          write("\n");
          finish(() => resolve(line));
          return;
        }
        if (code === 0x08 || code === 0x7f) {
          // Backspace, Delete — by code point, so surrogate pairs stay whole.
          const chars = Array.from(line);
          const removed = chars.pop() ?? "";
          line = chars.join("");
          lineBytes -= Buffer.byteLength(removed, "utf8");
          continue;
        }
        if (code === 0x15) {
          // Ctrl-U clears the line.
          line = "";
          lineBytes = 0;
          continue;
        }
        if (code < 0x20) {
          // Any other control byte is dropped, not recorded.
          continue;
        }
        const size = Buffer.byteLength(char, "utf8");
        if (lineBytes + size > MAX_INPUT_BYTES) {
          finish(() => reject(new InputTooLongError()));
          return;
        }
        lineBytes += size;
        line += char;
      }
    };
    const onClose = () => finish(() => reject(new StdinClosedError()));
    input.setRawMode(true);
    write(prompt);
    input.on("data", onData);
    input.on("end", onClose);
    input.on("error", onClose);
    // A hangup kills the process before any cleanup callback could run, so the
    // terminal is restored from the signal itself.
    process.once("SIGHUP", onClose);
  });
}

/**
 * Reads everything up to the first newline (or to EOF when there is none), and
 * at most MAX_INPUT_BYTES: past the cap it rejects with InputTooLongError
 * instead of buffering. "\n" cannot straddle a UTF-8 chunk boundary, so the
 * newline search only ever scans the freshly decoded chunk.
 */
export function readFirstLine(input: ReadableLike): Promise<string> {
  return new Promise((resolve, reject) => {
    const decoder = new TextDecoder("utf-8");
    let line = "";
    let total = 0;
    const cleanup = () => {
      input.removeListener("data", onData);
      input.removeListener("end", onEnd);
      input.removeListener("error", onError);
    };
    const onData = (chunk: Buffer | string) => {
      const bytes = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
      total += bytes.byteLength;
      if (total > MAX_INPUT_BYTES) {
        cleanup();
        reject(new InputTooLongError());
        return;
      }
      const text = decoder.decode(bytes, { stream: true });
      const newline = text.indexOf("\n");
      if (newline !== -1) {
        cleanup();
        resolve(line + text.slice(0, newline));
        return;
      }
      line += text;
    };
    const onEnd = () => {
      cleanup();
      resolve(line + decoder.decode());
    };
    const onError = (err: Error) => {
      cleanup();
      reject(err);
    };
    input.on("data", onData);
    input.on("end", onEnd);
    input.on("error", onError);
  });
}
