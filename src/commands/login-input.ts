import { Buffer } from "node:buffer";

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

/**
 * Reads one line with echo off: the prompt goes to `write`, typed characters go
 * nowhere. Enter submits; Ctrl-C resolves undefined, which the caller maps to
 * exit code 130; Ctrl-U clears the line; every other control byte is ignored.
 * Raw mode is taken BEFORE the prompt is written, so nothing can echo in the
 * gap. A stream 'end' or 'error' restores the terminal and resolves undefined.
 */
export function readSecret(
  input: TtyStdin,
  write: (text: string) => void,
  prompt: string,
): Promise<string | undefined> {
  return new Promise((resolve) => {
    const decoder = new TextDecoder("utf-8");
    let line = "";
    let settled = false;
    const settle = (value: string | undefined) => {
      if (settled) {
        return;
      }
      settled = true;
      input.removeListener("data", onData);
      input.removeListener("end", onEnd);
      input.removeListener("error", onError);
      input.setRawMode(false);
      resolve(value);
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
          settle(undefined);
          return;
        }
        if (code === 0x0d || code === 0x0a) {
          // Enter
          write("\n");
          settle(line);
          return;
        }
        if (code === 0x08 || code === 0x7f) {
          // Backspace, Delete — by code point, so surrogate pairs stay whole.
          line = Array.from(line).slice(0, -1).join("");
          continue;
        }
        if (code === 0x15) {
          // Ctrl-U clears the line.
          line = "";
          continue;
        }
        if (code < 0x20 || code === 0x7f) {
          // Any other control byte is dropped, not recorded.
          continue;
        }
        line += char;
      }
    };
    const onEnd = () => settle(undefined);
    const onError = () => settle(undefined);
    input.setRawMode(true);
    write(prompt);
    input.on("data", onData);
    input.on("end", onEnd);
    input.on("error", onError);
  });
}

/** Reads everything up to the first newline (or to EOF when there is none). */
export function readFirstLine(input: ReadableLike): Promise<string> {
  return new Promise((resolve, reject) => {
    const decoder = new TextDecoder("utf-8");
    let buffer = "";
    const cleanup = () => {
      input.removeListener("data", onData);
      input.removeListener("end", onEnd);
      input.removeListener("error", onError);
    };
    const onData = (chunk: Buffer | string) => {
      const bytes = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
      buffer += decoder.decode(bytes, { stream: true });
      const newline = buffer.indexOf("\n");
      if (newline !== -1) {
        cleanup();
        resolve(buffer.slice(0, newline));
      }
    };
    const onEnd = () => {
      cleanup();
      buffer += decoder.decode();
      resolve(buffer);
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
