import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { KEY } from "../test-support/fixtures";
import { assertNoKeyFragment } from "../test-support/redact";
import {
  InputTooLongError,
  type ReadableLike,
  readFirstLine,
  readSecret,
  StdinClosedError,
  type TtyStdin,
} from "./login-input";

class FakeTty extends EventEmitter {
  readonly rawModes: boolean[] = [];

  constructor(public isRaw = false) {
    super();
  }

  setRawMode(mode: boolean): void {
    this.rawModes.push(mode);
    this.isRaw = mode;
  }
}

function asTty(tty: FakeTty): TtyStdin {
  return tty;
}

describe("readSecret (real hidden reader)", () => {
  test("writes only the prompt and a newline — never the typed characters", async () => {
    const tty = new FakeTty();
    const writes: string[] = [];
    const secret = readSecret(asTty(tty), (text) => writes.push(text), "Router key: ");
    tty.emit("data", Buffer.from("mar_live_"));
    tty.emit("data", Buffer.from("SECRET"));
    tty.emit("data", Buffer.from("\r"));
    await expect(secret).resolves.toBe("mar_live_SECRET");
    expect(writes).toEqual(["Router key: ", "\n"]);
    expect(tty.rawModes).toEqual([true, false]);
  });

  test("takes raw mode BEFORE writing the prompt", async () => {
    const order: string[] = [];
    class OrderedTty extends EventEmitter {
      readonly rawModes: boolean[] = [];

      setRawMode(mode: boolean): void {
        this.rawModes.push(mode);
        order.push(`raw:${mode}`);
      }
    }
    const tty = new OrderedTty();
    const secret = readSecret(
      tty as unknown as TtyStdin,
      (text) => order.push(`write:${JSON.stringify(text)}`),
      "P: ",
    );
    tty.emit("data", Buffer.from("\r"));
    await expect(secret).resolves.toBe("");
    expect(order.slice(0, 2)).toEqual(["raw:true", 'write:"P: "']);
  });

  test("Ctrl-C resolves undefined and restores the terminal", async () => {
    const tty = new FakeTty();
    const writes: string[] = [];
    const secret = readSecret(asTty(tty), (text) => writes.push(text), "Router key: ");
    tty.emit("data", Buffer.concat([Buffer.from("abc"), Buffer.from([0x03])]));
    await expect(secret).resolves.toBeUndefined();
    expect(writes).toEqual(["Router key: ", "\n"]);
    expect(tty.rawModes).toEqual([true, false]);
  });

  test("Ctrl-U clears the line so far", async () => {
    const tty = new FakeTty();
    const secret = readSecret(asTty(tty), () => {}, "P: ");
    tty.emit("data", Buffer.concat([Buffer.from("abc"), Buffer.from([0x15]), Buffer.from("xy\r")]));
    await expect(secret).resolves.toBe("xy");
  });

  test("other control bytes are ignored, not recorded", async () => {
    const tty = new FakeTty();
    const secret = readSecret(asTty(tty), () => {}, "P: ");
    // 0x01 (Ctrl-A), 0x02, 0x1b (ESC), 0x00 — dropped; letters kept.
    tty.emit("data", Buffer.concat([Buffer.from([0x01, 0x02]), Buffer.from("a")]));
    tty.emit("data", Buffer.concat([Buffer.from([0x1b, 0x00]), Buffer.from("b\r")]));
    await expect(secret).resolves.toBe("ab");
  });

  test("a CSI sequence is swallowed whole — its tail never lands on the line", async () => {
    const tty = new FakeTty();
    const secret = readSecret(asTty(tty), () => {}, "P: ");
    // Shift+Left (ESC [ 1 ; 2 D), then plain typing: only the plain chars survive.
    const csi = Buffer.concat([Buffer.from([0x1b]), Buffer.from("[1;2D")]);
    tty.emit("data", Buffer.concat([csi, Buffer.from("x\r")]));
    await expect(secret).resolves.toBe("x");
  });

  test("a CSI sequence split across chunks is swallowed just as completely", async () => {
    const tty = new FakeTty();
    const secret = readSecret(asTty(tty), () => {}, "P: ");
    tty.emit("data", Buffer.concat([Buffer.from([0x1b]), Buffer.from("[1;2")]));
    tty.emit("data", Buffer.from("Dx\r"));
    await expect(secret).resolves.toBe("x");
  });

  test("an unterminated CSI never swallows Ctrl-C (a C0 control aborts the sequence)", async () => {
    const tty = new FakeTty();
    const secret = readSecret(asTty(tty), () => {}, "P: ");
    tty.emit(
      "data",
      Buffer.concat([
        Buffer.from("key"),
        Buffer.from([0x1b]),
        Buffer.from("["),
        Buffer.from([0x03]),
      ]),
    );
    tty.emit("end"); // a regression rejects (StdinClosedError) instead of hanging
    await expect(secret).resolves.toBeUndefined();
  });

  test("an unterminated CSI never swallows Enter", async () => {
    const tty = new FakeTty();
    const secret = readSecret(asTty(tty), () => {}, "P: ");
    tty.emit("data", Buffer.concat([Buffer.from("ab"), Buffer.from([0x1b]), Buffer.from("[\r")]));
    tty.emit("end"); // a regression rejects (StdinClosedError) instead of hanging
    await expect(secret).resolves.toBe("ab");
  });

  test("an SS3 sequence (ESC O <byte>, e.g. application-mode arrows) is swallowed whole", async () => {
    const tty = new FakeTty();
    const secret = readSecret(asTty(tty), () => {}, "P: ");
    tty.emit("data", Buffer.concat([Buffer.from([0x1b]), Buffer.from("OA"), Buffer.from("x\r")]));
    tty.emit("end");
    await expect(secret).resolves.toBe("x");
  });

  test("an unterminated SS3 never swallows Enter", async () => {
    const tty = new FakeTty();
    const secret = readSecret(asTty(tty), () => {}, "P: ");
    tty.emit("data", Buffer.concat([Buffer.from("ab"), Buffer.from([0x1b]), Buffer.from("O\r")]));
    tty.emit("end"); // a regression rejects (StdinClosedError) instead of hanging
    await expect(secret).resolves.toBe("ab");
  });

  test("an unterminated SS3 never swallows Ctrl-C", async () => {
    const tty = new FakeTty();
    const secret = readSecret(asTty(tty), () => {}, "P: ");
    tty.emit(
      "data",
      Buffer.concat([
        Buffer.from("ab"),
        Buffer.from([0x1b]),
        Buffer.from("O"),
        Buffer.from([0x03]),
      ]),
    );
    tty.emit("end"); // a regression rejects (StdinClosedError) instead of hanging
    await expect(secret).resolves.toBeUndefined();
  });

  test("a lone ESC is dropped; the byte after it still types", async () => {
    const tty = new FakeTty();
    const secret = readSecret(asTty(tty), () => {}, "P: ");
    const esc = Buffer.concat([Buffer.from("a"), Buffer.from([0x1b]), Buffer.from("b")]);
    tty.emit("data", Buffer.concat([esc, Buffer.from("\r")]));
    await expect(secret).resolves.toBe("ab");
  });

  test("Ctrl-D on an empty line is stdin closed, not an empty submit", async () => {
    const tty = new FakeTty();
    const writes: string[] = [];
    const secret = readSecret(asTty(tty), (text) => writes.push(text), "P: ");
    tty.emit("data", Buffer.from([0x04]));
    await expect(secret).rejects.toBeInstanceOf(StdinClosedError);
    expect(tty.rawModes).toEqual([true, false]);
    expect(writes).toEqual(["P: ", "\n"]); // the error never lands on the prompt line
  });

  test("Ctrl-D on a typed line submits it, like Enter", async () => {
    const tty = new FakeTty();
    const writes: string[] = [];
    const secret = readSecret(asTty(tty), (text) => writes.push(text), "P: ");
    tty.emit("data", Buffer.concat([Buffer.from("abc"), Buffer.from([0x04])]));
    await expect(secret).resolves.toBe("abc");
    expect(writes).toEqual(["P: ", "\n"]);
    expect(tty.rawModes).toEqual([true, false]);
  });

  test("backspace and DEL remove the last code point", async () => {
    const tty = new FakeTty();
    const secret = readSecret(asTty(tty), () => {}, "P: ");
    tty.emit(
      "data",
      Buffer.concat([Buffer.from("abcd"), Buffer.from([0x08]), Buffer.from([0x7f])]),
    );
    tty.emit("data", Buffer.from("\r"));
    await expect(secret).resolves.toBe("ab");
  });

  test("decodes a code point split across chunks (utf-8 stream mode)", async () => {
    const tty = new FakeTty();
    const secret = readSecret(asTty(tty), () => {}, "P: ");
    tty.emit("data", Buffer.from([0xc3])); // first byte of é
    tty.emit("data", Buffer.concat([Buffer.from([0xa9]), Buffer.from("\r")]));
    await expect(secret).resolves.toBe("é");
  });

  test("stream end restores raw mode and rejects with StdinClosedError", async () => {
    const tty = new FakeTty();
    const secret = readSecret(asTty(tty), () => {}, "P: ");
    tty.emit("data", Buffer.from("partial"));
    tty.emit("end");
    await expect(secret).rejects.toBeInstanceOf(StdinClosedError);
    expect(tty.rawModes).toEqual([true, false]);
  });

  test("stream error restores raw mode and rejects with StdinClosedError", async () => {
    const tty = new FakeTty();
    const secret = readSecret(asTty(tty), () => {}, "P: ");
    tty.emit("error", new Error("EIO"));
    await expect(secret).rejects.toBeInstanceOf(StdinClosedError);
    expect(tty.rawModes).toEqual([true, false]);
  });

  test("SIGHUP restores raw mode and rejects with StdinClosedError too", async () => {
    const tty = new FakeTty();
    const secret = readSecret(asTty(tty), () => {}, "P: ");
    process.kill(process.pid, "SIGHUP");
    await expect(secret).rejects.toBeInstanceOf(StdinClosedError);
    expect(tty.rawModes).toEqual([true, false]);
  });

  test("typing past 4096 bytes rejects with InputTooLongError and restores the tty", async () => {
    const tty = new FakeTty();
    const writes: string[] = [];
    const secret = readSecret(asTty(tty), (text) => writes.push(text), "P: ");
    tty.emit("data", Buffer.from("a".repeat(4097)));
    await expect(secret).rejects.toBeInstanceOf(InputTooLongError);
    expect(tty.rawModes).toEqual([true, false]);
    expect(writes).toEqual(["P: ", "\n"]); // the error never lands on the prompt line
  });

  test("exactly 4096 bytes is still accepted", async () => {
    const tty = new FakeTty();
    const line = "a".repeat(4096);
    const secret = readSecret(asTty(tty), () => {}, "P: ");
    tty.emit("data", Buffer.from(line));
    tty.emit("data", Buffer.from("\r"));
    await expect(secret).resolves.toBe(line);
  });
});

// These inject synchronous writer exceptions, not real stderr failures. Production
// uses process.stderr.write; asynchronous error events and backpressure are not probed.
describe("readSecret injected synchronous writer failures", () => {
  const exits = [
    "prompt",
    "CR",
    "LF",
    "Ctrl-C",
    "empty Ctrl-D",
    "typed Ctrl-D",
    "overflow",
    "end",
    "error",
    "SIGHUP",
  ] as const;

  for (const priorRaw of [false, true]) {
    for (const exit of exits) {
      test(`${exit} rejects and restores prior raw=${priorRaw}`, async () => {
        const tty = new FakeTty(priorRaw);
        const writes: string[] = [];
        const failure = new Error("injected synchronous writer failure");
        const unrelated = () => {};
        for (const event of ["data", "end", "error"]) {
          tty.on(event, unrelated);
        }
        process.on("SIGHUP", unrelated);
        const hangupsBefore = process.listeners("SIGHUP");
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          const secret = readSecret(
            tty,
            (text) => {
              writes.push(text);
              expect(tty.isRaw).toBe(true);
              if (exit === "prompt" || text === "\n") {
                throw failure;
              }
            },
            "Router key: ",
          );
          // Attach rejection handling before emitting; a broken callback must not
          // leave an unhandled rejection or an indefinitely pending test.
          const outcome = secret.then(
            () => "unexpected resolution",
            (error: unknown) => error,
          );
          if (exit !== "prompt") {
            if (exit !== "empty Ctrl-D") {
              tty.emit("data", Buffer.from(KEY));
            }
            expect(() => {
              switch (exit) {
                case "CR":
                  tty.emit("data", "\r");
                  break;
                case "LF":
                  tty.emit("data", "\n");
                  break;
                case "Ctrl-C":
                  tty.emit("data", "\x03");
                  break;
                case "empty Ctrl-D":
                case "typed Ctrl-D":
                  tty.emit("data", "\x04");
                  break;
                case "overflow":
                  tty.emit("data", "x".repeat(4097));
                  break;
                case "end":
                  tty.emit("end");
                  break;
                case "error":
                  tty.emit("error", new Error("injected input error"));
                  break;
                case "SIGHUP":
                  process.emit("SIGHUP");
                  break;
              }
            }).not.toThrow();
          }
          const timeout = new Promise<string>((resolve) => {
            timer = setTimeout(() => resolve("reader did not settle"), 250);
          });
          expect(await Promise.race([outcome, timeout])).toBe(failure);
          expect(tty.rawModes).toEqual([true, priorRaw]);
          expect(tty.isRaw).toBe(priorRaw);
          for (const event of ["data", "end", "error"]) {
            expect(tty.listeners(event)).toEqual([unrelated]);
          }
          expect(process.listeners("SIGHUP")).toEqual(hangupsBefore);
          expect(writes).toEqual(exit === "prompt" ? ["Router key: "] : ["Router key: ", "\n"]);
          assertNoKeyFragment(writes.join(""), KEY);
          assertNoKeyFragment(failure.message, KEY);
        } finally {
          clearTimeout(timer);
          // Remove only listeners added by this test, even when a regression leaks
          // the reader's hangup callback; never disturb another test's listeners.
          for (const listener of process.listeners("SIGHUP")) {
            if (!hangupsBefore.includes(listener)) {
              process.removeListener("SIGHUP", listener);
            }
          }
          process.removeListener("SIGHUP", unrelated);
          tty.removeAllListeners();
          tty.setRawMode(priorRaw);
        }
      });
    }
  }

  for (const cancel of [false, true]) {
    test(`normal ${cancel ? "cancellation" : "submit"} preserves an already raw terminal`, async () => {
      const tty = new FakeTty(true);
      const writes: string[] = [];
      try {
        const secret = readSecret(tty, (text) => writes.push(text), "Router key: ");
        tty.emit("data", `${KEY}${cancel ? "\x03" : "\r"}`);
        await expect(secret).resolves.toBe(cancel ? undefined : KEY);
        expect(tty.rawModes).toEqual([true, true]);
        assertNoKeyFragment(writes.join(""), KEY);
      } finally {
        tty.emit("end");
        tty.removeAllListeners();
      }
    });
  }
});

class FakeReadable extends EventEmitter {}

function asReadable(stream: FakeReadable): ReadableLike {
  return stream;
}

describe("readFirstLine (real stdin reader)", () => {
  test("stops at the first newline, even mid-chunk", async () => {
    const stream = new FakeReadable();
    const line = readFirstLine(asReadable(stream));
    stream.emit("data", Buffer.from("mar_live_X\nrest is ignored"));
    await expect(line).resolves.toBe("mar_live_X");
  });

  test("a valid line followed by an 8 KiB tail in the SAME chunk resolves", async () => {
    const stream = new FakeReadable();
    const line = readFirstLine(asReadable(stream));
    stream.emit("data", Buffer.concat([Buffer.from("mar_live_X\n"), Buffer.alloc(8 * 1024, 0x61)]));
    await expect(line).resolves.toBe("mar_live_X");
  });

  test("a first line longer than the cap rejects even when newline-terminated", async () => {
    const stream = new FakeReadable();
    const line = readFirstLine(asReadable(stream));
    stream.emit("data", Buffer.from(`${"a".repeat(4097)}\nignored tail`));
    await expect(line).rejects.toBeInstanceOf(InputTooLongError);
  });

  test("finds a newline that arrives in a later chunk (no whole-buffer rescans)", async () => {
    const stream = new FakeReadable();
    const line = readFirstLine(asReadable(stream));
    stream.emit("data", Buffer.from("first-chunk-no-newline"));
    stream.emit("data", Buffer.from(" then\nrest is ignored"));
    await expect(line).resolves.toBe("first-chunk-no-newline then");
  });

  test("resolves the whole buffer at EOF when there is no newline", async () => {
    const stream = new FakeReadable();
    const line = readFirstLine(asReadable(stream));
    stream.emit("data", "mar_live_NOEOF");
    stream.emit("end");
    await expect(line).resolves.toBe("mar_live_NOEOF");
  });

  test("accepts exactly 4096 bytes without a newline", async () => {
    const stream = new FakeReadable();
    const line = readFirstLine(asReadable(stream));
    stream.emit("data", Buffer.from("a".repeat(4096)));
    stream.emit("end");
    await expect(line).resolves.toBe("a".repeat(4096));
  });

  test("rejects with InputTooLongError the moment the total passes 4096 bytes", async () => {
    const stream = new FakeReadable();
    const line = readFirstLine(asReadable(stream));
    stream.emit("data", Buffer.from("a".repeat(4096)));
    stream.emit("data", Buffer.from("b"));
    await expect(line).rejects.toBeInstanceOf(InputTooLongError);
  });

  test("a 1 MiB no-newline stream is refused at once, not buffered", async () => {
    const stream = new FakeReadable();
    const started = Date.now();
    const line = readFirstLine(asReadable(stream));
    // One chunk per 64 KiB, like a real pipe; the cap trips on the first one.
    const chunk = Buffer.from("a".repeat(64 * 1024));
    for (let i = 0; i < 16; i++) {
      stream.emit("data", chunk);
    }
    stream.emit("end");
    await expect(line).rejects.toBeInstanceOf(InputTooLongError);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  test("a 1 MiB unterminated line in a single chunk is refused too", async () => {
    const stream = new FakeReadable();
    const line = readFirstLine(asReadable(stream));
    stream.emit("data", Buffer.alloc(1024 * 1024, 0x61));
    stream.emit("end");
    await expect(line).rejects.toBeInstanceOf(InputTooLongError);
  });

  test("decodes a code point split across chunks", async () => {
    const stream = new FakeReadable();
    const line = readFirstLine(asReadable(stream));
    stream.emit("data", Buffer.from([0xf0, 0x9f])); // first half of an emoji
    stream.emit("data", Buffer.from([0x98, 0x80]));
    stream.emit("end");
    await expect(line).resolves.toBe("😀");
  });

  test("rejects on a stream error so the caller can exit cleanly", async () => {
    const stream = new FakeReadable();
    const line = readFirstLine(asReadable(stream));
    stream.emit("error", new Error("EPIPE"));
    await expect(line).rejects.toThrow("EPIPE");
  });
});
