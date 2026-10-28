import * as clack from "@clack/prompts";

// The one seam between commands and a real terminal. Commands only talk to
// `Prompter`, so tests drive them with scripted answers and the demo recording
// can replay them. Cancelling (Esc or Ctrl-C) always surfaces as `Cancelled`.

export class Cancelled extends Error {
  constructor() {
    super("cancelled");
    this.name = "Cancelled";
  }
}

export interface Spin {
  update(msg: string): void;
  succeed(msg: string): void;
  fail(msg: string): void;
}

export interface Prompter {
  intro(title: string): void;
  outro(text: string): void;
  note(body: string, title?: string): void;
  step(kind: "ok" | "warn" | "fail" | "info", msg: string): void;
  text(o: { message: string; initial?: string; placeholder?: string; validate?: (v: string) => string | undefined }): Promise<string>;
  secret(o: { message: string; validate?: (v: string) => string | undefined }): Promise<string>;
  confirm(o: { message: string; initial?: boolean }): Promise<boolean>;
  select<T extends string>(o: { message: string; options: { value: T; label: string; hint?: string }[]; initial?: T }): Promise<T>;
  spin(msg: string): Spin;
}

function validator(
  validate: ((v: string) => string | undefined) | undefined,
): { validate?: (v: string | undefined) => string | undefined } {
  return validate ? { validate: (v) => validate(v ?? "") } : {};
}

function ask<T>(v: T): Exclude<T, symbol> {
  if (clack.isCancel(v)) throw new Cancelled();
  return v as Exclude<T, symbol>;
}

export const clackPrompter: Prompter = {
  intro: (t) => clack.intro(t),
  outro: (t) => clack.outro(t),
  note: (b, t) => clack.note(b, t),
  step: (kind, msg) =>
    kind === "ok"
      ? clack.log.success(msg)
      : kind === "warn"
        ? clack.log.warn(msg)
        : kind === "fail"
          ? clack.log.error(msg)
          : clack.log.info(msg),
  text: async (o) =>
    ask(
      await clack.text({
        message: o.message,
        // A default, not a prefilled value: typing replaces it instead of
        // appending to it, and Enter on an empty line keeps it.
        ...(o.initial !== undefined ? { defaultValue: o.initial } : {}),
        ...((o.placeholder ?? o.initial) !== undefined ? { placeholder: (o.placeholder ?? o.initial) as string } : {}),
        ...validator(o.validate),
      }),
    ),
  secret: async (o) =>
    ask(
      await clack.password({
        message: o.message,
        mask: "•",
        ...validator(o.validate),
      }),
    ),
  confirm: async (o) =>
    ask(await clack.confirm({ message: o.message, initialValue: o.initial ?? false })),
  select: async <T extends string>(o: {
    message: string;
    options: { value: T; label: string; hint?: string }[];
    initial?: T;
  }) =>
    ask(
      await clack.select<T>({
        message: o.message,
        options: o.options.map((x) => ({ value: x.value, label: x.label, ...(x.hint ? { hint: x.hint } : {}) })) as never,
        ...(o.initial !== undefined ? { initialValue: o.initial } : {}),
      }),
    ),
  spin: (msg) => {
    const s = clack.spinner();
    s.start(msg);
    return {
      update: (m) => s.message(m),
      succeed: (m) => s.stop(m),
      fail: (m) => s.stop(m),
    };
  },
};
