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
 * exit code 130; Ctrl-D rejects with StdinClosedError on an empty line and
 * submits a typed one; Ctrl-U clears the line; every other control byte is
 * ignored, and terminal escape sequences (ESC [ … final byte 0x40-0x7e) are
 * swallowed whole so arrow keys cannot leave their tail on the line. Raw mode
 * is taken BEFORE the prompt is written, so nothing can echo in the gap. A
 * stream 'end'/'error' — or SIGHUP — restores the terminal and rejects with
 * StdinClosedError, which the caller maps to exit 1; more than
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
    /** Terminal-escape sequence state: nothing pending, ESC seen, inside a CSI sequence. */
    let escapeState: "none" | "esc" | "csi" | "ss3" = "none";
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
        // CSI sequences are consumed until their final byte (0x40-0x7e); the
        // state lives outside the loop so a sequence split across chunks is
        // swallowed just as completely as one delivered whole.
        if (escapeState === "csi") {
          if (code >= 0x20 && code <= 0x3f) {
            continue; // parameter / intermediate byte
          }
          escapeState = "none";
          if (code >= 0x40 && code <= 0x7e) {
            continue; // final byte ends the sequence
          }
          // A C0 control (or anything else) aborts the sequence and is handled
          // normally, so Enter and Ctrl-C always work at a key prompt.
        }
        if (escapeState === "ss3") {
          escapeState = "none";
          if (code >= 0x20) {
            continue; // ESC O <byte>: application-mode arrows, F1-F4
          }
        }
        if (code === 0x1b) {
          escapeState = "esc";
          continue;
        }
        if (escapeState === "esc") {
          escapeState = "none";
          if (code === 0x5b) {
            escapeState = "csi";
            continue;
          }
          if (code === 0x4f) {
            escapeState = "ss3";
            continue;
          }
          // A lone ESC prefixes a two-byte escape; drop the ESC and treat the
          // next byte like any other input below.
        }
        if (code === 0x03) {
          // Ctrl-C
          write("\n");
          finish(() => resolve(undefined));
          return;
        }
        if (code === 0x04) {
          // Ctrl-D: EOF on an empty line, submit on a typed one.
          if (line === "") {
            write("\n");
            finish(() => reject(new StdinClosedError()));
            return;
          }
          write("\n");
          finish(() => resolve(line));
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
          write("\n");
          finish(() => reject(new InputTooLongError()));
          return;
        }
        lineBytes += size;
        line += char;
      }
    };
    const onClose = () => {
      write("\n");
      finish(() => reject(new StdinClosedError()));
    };
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
 * at most MAX_INPUT_BYTES of the FIRST LINE: past the cap it rejects with
 * InputTooLongError instead of buffering, while a valid line followed by any
 * amount of tail in the same chunk still resolves. "\n" cannot straddle a
 * UTF-8 chunk boundary, so the newline search only ever scans the freshly
 * decoded chunk, and only the bytes before it are charged to the cap.
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
      const text = decoder.decode(bytes, { stream: true });
      const newline = text.indexOf("\n");
      if (newline !== -1) {
        // Charge only the bytes of the line itself; the tail after the newline
        // is discarded, however large, and never buffered.
        total += Buffer.byteLength(text.slice(0, newline), "utf8");
        cleanup();
        if (total > MAX_INPUT_BYTES) {
          reject(new InputTooLongError());
          return;
        }
        resolve(line + text.slice(0, newline));
        return;
      }
      total += Buffer.byteLength(text, "utf8");
      if (total > MAX_INPUT_BYTES) {
        cleanup();
        reject(new InputTooLongError());
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
