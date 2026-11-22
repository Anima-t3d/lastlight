/**
 * `@bot retry [hint]`: the maintainer's hint reaches the architect, fenced and
 * labelled as untrusted guidance — and renders nothing at all without one.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderTemplate, type TemplateContext } from "lastlight-workflow-engine";

const PROMPT = readFileSync(join(import.meta.dirname, "../../workflows/prompts/architect.md"), "utf8");

function render(extra: Record<string, unknown>): string {
  return renderTemplate(PROMPT, {
    owner: "acme",
    repo: "widgets",
    branch: "lastlight/42-toggle",
    issueDir: ".lastlight/issue-42",
    issueNumber: 42,
    issueLabels: [],
    ...extra,
  } as unknown as TemplateContext);
}

describe("architect prompt — the retry hint", () => {
  it("renders the hint in a fenced block, labelled as a maintainer's untrusted guidance", () => {
    const out = render({ _hint: "fix the import in src/a.ts" });
    expect(out).toMatch(/maintainer/i);
    expect(out).toMatch(/untrusted/i);
    expect(out).toContain("```text\nfix the import in src/a.ts\n```");
  });

  it("renders nothing without a hint", () => {
    const out = render({});
    expect(out).not.toMatch(/untrusted/i);
    expect(out).not.toContain("```text");
  });

  it("a hint holding template syntax is not re-rendered", () => {
    const out = render({ _hint: "{{owner}} {{#if x}}y{{/if}}" });
    expect(out).toContain("{{owner}} {{#if x}}y{{/if}}");
  });
});
