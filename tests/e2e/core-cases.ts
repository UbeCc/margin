import { expect, test } from "@playwright/test";
import { open, md, mod, docEnd, lineStart } from "./core-shared";

const find = (page: import("@playwright/test").Page, q: string) =>
  page.evaluate((q) => window.__core.ed.exec({ kind: "find", query: q }), q);

export function coreCases(): void {
  test.describe("core editing", () => {
    test("lossless load, markers hidden until caret enters", async ({
      page,
    }) => {
      const src = "# Title\n\nSome **bold** text\n\n- a\n- b\n";
      await open(page, src);
      expect(await md(page)).toBe(src);
      const strong = page.locator(".md-strong").first();
      await expect(strong.locator(".md-meta").first()).toBeHidden();
      await find(page, "bold");
      await expect(strong).toHaveClass(/md-expand/);
      await expect(strong.locator(".md-meta").first()).toBeVisible();
      await expect(page.locator(".md-gutter")).toHaveCount(2);
    });

    test("typing, Enter split, heading shortcut, undo/redo", async ({
      page,
    }) => {
      await open(page, "hello world\n");
      await find(page, "hello");
      await page.keyboard.press("ArrowRight");
      await page.keyboard.type("!");
      expect(await md(page)).toBe("hello! world\n");
      await page.keyboard.press("Enter");
      expect(await md(page)).toBe("hello!\n\n world\n");
      await page.keyboard.type("# ");
      await expect(page.locator(".md-heading")).toHaveCount(1);
      expect(await md(page)).toBe("hello!\n\n#  world\n");
      await page.keyboard.press(`${mod}+z`);
      await page.keyboard.press(`${mod}+z`);
      expect(await md(page)).toBe("hello! world\n");
      await page.keyboard.press(`${mod}+Shift+z`);
      expect(await md(page)).toBe("hello!\n\n world\n");
    });

    test("lists: Enter continues, empty item exits, Tab indents, Backspace merges", async ({
      page,
    }) => {
      await open(page, "- one\n");
      await find(page, "one");
      await page.keyboard.press("ArrowRight");
      await page.keyboard.press("Enter");
      await page.keyboard.type("two");
      expect(await md(page)).toBe("- one\n- two\n");
      await page.keyboard.press("Tab");
      expect(await md(page)).toBe("- one\n  - two\n");
      await page.keyboard.press("Shift+Tab");
      await page.keyboard.press("Enter");
      await page.keyboard.press("Enter");
      await page.keyboard.type("para");
      expect(await md(page)).toBe("- one\n- two\n\npara\n");
      await page.keyboard.press(lineStart);
      await page.keyboard.press("Backspace");
      expect(await md(page)).toBe("- one\n- twopara\n");
    });

    test("task checkbox toggles source", async ({ page }) => {
      await open(page, "- [ ] todo\n");
      await page.locator(".md-task-box").click();
      expect(await md(page)).toBe("- [x] todo\n");
    });

    test("``` + Enter mounts a code widget; Cmd+click opens links", async ({
      page,
    }) => {
      await open(page, "see [x](https://a.b)\n\n\n", "&blocks=0");
      await page
        .locator(".md-link")
        .click({ modifiers: [mod === "Meta" ? "Meta" : "Control"] });
      expect(await page.evaluate(() => window.__core.opened)).toEqual([
        "https://a.b",
      ]);
      await page.keyboard.press(docEnd);
      await page.keyboard.type("```js");
      await page.keyboard.press("Enter");
      await expect(page.locator(".md-widget pre.md-fallback")).toBeVisible();
      await page.keyboard.type("let a");
      expect(await md(page)).toBe(
        "see [x](https://a.b)\n\n```js\nlet a\n```\n",
      );
    });

    test("IME composition (Chinese) commits once", async ({
      page,
      browserName,
    }) => {
      test.skip(browserName !== "chromium", "CDP IME only in Chromium");
      await open(page, "ab\n");
      await find(page, "a");
      await page.keyboard.press("ArrowRight");
      const cdp = await page.context().newCDPSession(page);
      await cdp.send("Input.imeSetComposition", {
        text: "ni",
        selectionStart: 2,
        selectionEnd: 2,
      });
      await cdp.send("Input.imeSetComposition", {
        text: "nihao",
        selectionStart: 5,
        selectionEnd: 5,
      });
      await cdp.send("Input.insertText", { text: "你好" });
      await expect.poll(() => md(page)).toBe("a你好b\n");
      await page.keyboard.type("c");
      expect(await md(page)).toBe("a你好cb\n");
    });

    test("paste HTML becomes markdown; copy gives markdown", async ({
      page,
    }) => {
      await open(page, "x\n");
      await find(page, "x");
      await page.keyboard.press("ArrowRight");
      await page.evaluate(() => {
        const dt = new DataTransfer();
        dt.setData(
          "text/html",
          "<h2>T</h2><p>a <b>b</b></p><ul><li>c</li></ul>",
        );
        dt.setData("text/plain", "T a b c");
        document
          .querySelector(".md-editor")!
          .dispatchEvent(
            new ClipboardEvent("paste", {
              clipboardData: dt,
              bubbles: true,
              cancelable: true,
            }),
          );
      });
      expect(await md(page)).toBe("x\n\n## T\n\na **b**\n\n- c\n");
    });

    test("exec: heading, strong, block quote, find/replace, stats, html", async ({
      page,
    }) => {
      await open(page, "alpha beta\n\n中文字 ok\n");
      const ex = (c: object) =>
        page.evaluate((c) => window.__core.ed.exec(c as never), c);
      await find(page, "beta");
      await ex({ kind: "mark", mark: "strong" });
      expect(await md(page)).toBe("alpha **beta**\n\n中文字 ok\n");
      await ex({ kind: "heading", level: 2 });
      expect(await md(page)).toBe("## alpha **beta**\n\n中文字 ok\n");
      await ex({
        kind: "replace",
        query: "ok",
        replacement: "fine",
        all: true,
      });
      expect(await md(page)).toBe("## alpha **beta**\n\n中文字 fine\n");
      const stats = await page.evaluate(() => window.__core.ed.getStats());
      expect(stats.words).toBe(6);
      const html = await page.evaluate(() => window.__core.ed.renderHTML());
      const id = await page.evaluate(() => window.__core.ed.getOutline()[0].id);
      expect(html).toContain(`<h2 id="${id}">alpha <strong>beta</strong></h2>`);
      await find(page, "中文");
      await ex({ kind: "block", block: "quote" });
      expect(await md(page)).toBe("## alpha **beta**\n\n> 中文字 fine\n");
    });

    test("source mode round-trip", async ({ page }) => {
      await open(page, "# a\n");
      await page.evaluate(() => window.__core.ed.setSourceMode(true));
      await expect(page.locator(".md-editor")).toBeHidden();
      await page.evaluate(() => window.__core.ed.setSourceMode(false));
      await expect(page.locator(".md-heading")).toHaveCount(1);
      expect(await md(page)).toBe("# a\n");
    });
  });
}

export function widgetCases(): void {
  test.describe("core + real block widgets", () => {
    test("arrow into a code fence, edit, Escape out", async ({ page }) => {
      await open(page, "p\n\n```js\nx\n```\n\nq\n");
      await page.evaluate(() => window.__core.ed.exec({ kind: "find", query: "p" }));
      await page.keyboard.press("ArrowRight");
      await page.keyboard.press("ArrowDown");
      await expect(page.locator(".md-widget .cm-focused")).toHaveCount(1);
      await page.keyboard.type("y");
      await expect.poll(() => md(page)).toBe("p\n\n```js\nyx\n```\n\nq\n");
      await page.keyboard.press("Escape");
      await page.keyboard.type("Z");
      await expect.poll(() => md(page)).toBe("p\n\n```js\nyx\n```\n\nZq\n");
    });

    test("table shortcut mounts the table widget; headings fire outline events", async ({ page }) => {
      await open(page, "x\n\n\n");
      await page.keyboard.press("Tab"); // no-op outside lists
      await page.locator(".md-editor").focus();
      await page.keyboard.press(docEnd);
      await page.keyboard.type("|a|b|");
      await page.keyboard.press("Enter");
      await expect(page.locator('.md-widget[data-type="table"] table')).toHaveCount(1);
      expect(await md(page)).toBe("x\n\n|a|b|\n| --- | --- |\n|   |   |\n");
      const before = await page.evaluate(() => window.__core.outlineEvents);
      await page.evaluate(() => window.__core.ed.exec({ kind: "find", query: "x" }));
      await page.evaluate(() => window.__core.ed.exec({ kind: "heading", level: 1 }));
      expect(await page.evaluate(() => window.__core.outlineEvents)).toBeGreaterThan(before);
    });
  });
}
