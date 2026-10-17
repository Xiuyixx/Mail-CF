import { test, expect } from "@playwright/test";

const viewports = [320, 375, 390, 412, 768, 1024, 1440, 844];
for (const width of viewports) {
  test(`login and compose fit ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: width === 844 ? 390 : 800 });
    await page.goto("/login");
    await expect(page.locator("label[for=password]")).toBeVisible();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBeLessThanOrEqual(width);
    await page.locator("#password").fill("StrongPassword123");
    const focusGap = await page.locator("#password").evaluate((input) => {
      const style = getComputedStyle(input);
      const button = document.querySelector("#login button[type=submit]");
      return {
        outlineStyle: style.outlineStyle,
        gap:
          button.getBoundingClientRect().top -
          input.getBoundingClientRect().bottom -
          parseFloat(style.outlineWidth) -
          parseFloat(style.outlineOffset),
      };
    });
    expect(focusGap.outlineStyle).toBe("solid");
    expect(focusGap.gap).toBeGreaterThanOrEqual(8);
    await page.locator("button[type=submit]").click();
    await expect(page).toHaveURL(/\/$/);
    await expect(page.locator("#compose")).toBeVisible();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBeLessThanOrEqual(width);
    await page.locator("#to").fill("a@example.net");
    await page.locator("#fromPrefix").fill("noreply");
    await page.locator("#subject").fill("测试");
    await page.locator("#text").fill("正文");
    await page.locator("#files").setInputFiles({
      name: "long-attachment-".repeat(5) + ".txt",
      mimeType: "text/plain",
      buffer: Buffer.from("test"),
    });
    await expect(page.locator("#fileNames")).toContainText("long-attachment-");
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBeLessThanOrEqual(width);
    await page.locator("#send").click();
    await expect(page.locator("#message")).toHaveText("发送成功");
    await page.locator("#logout").click();
    await expect(page).toHaveURL(/\/login$/);
  });
}

// Measure real DOM text spans AND text-node ranges, not native pseudo styles.
for (const width of [320, 375, 390, 768, 1440]) {
  test(`attachment text centers and picker activation at ${width}px`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width, height: 800 });
    await page.goto("/login");
    await page.locator("#password").fill("StrongPassword123");
    await page.locator("button[type=submit]").click();
    await expect(page.locator("#compose")).toBeVisible();
    const button = page.getByRole("button", {
      name: "选择文件，附件（可选）",
      exact: true,
    });
    const states = [
      ["empty", []],
      ["one", ["Xiuyixx.jpeg"]],
      ["multiple", ["a.txt", "b.txt"]],
      ["chinese", ["附件中文文件名称".repeat(12) + ".txt"]],
      ["latin", ["long-Latin-filename-".repeat(12) + ".txt"]],
    ];
    for (const [state, names] of states) {
      // Clear via the real removal UI; native FileList must follow.
      while (await page.locator(".file-remove").count())
        await page.locator(".file-remove").first().click();
      expect(
        await page.locator("#files").evaluate((input) => input.files.length),
      ).toBe(0);
      if (names.length) {
        // Real trusted mouse/keyboard events must open the native chooser.
        const chooserPromise = page.waitForEvent("filechooser");
        if (state === "one") await button.click();
        else {
          await button.focus();
          await page.keyboard.press(state === "multiple" ? "Enter" : "Space");
        }
        const chooser = await chooserPromise;
        expect(chooser.isMultiple()).toBe(true);
        await chooser.setFiles(
          names.map((name) => ({
            name,
            mimeType: "text/plain",
            buffer: Buffer.from("test"),
          })),
        );
      }
      await expect(page.locator("#fileStatusText")).toHaveText(
        names.length === 0
          ? "未选择文件"
          : names.length === 1
            ? names[0]
            : "已选择 2 个文件",
      );
      await button.scrollIntoViewIfNeeded();
      const geometry = await page.locator(".file-picker").evaluate((picker) => {
        const center = (rect) => rect.top + rect.height / 2;
        const rect = picker.getBoundingClientRect();
        const button = picker.querySelector("button");
        const spans = [
          button.querySelector("span"),
          picker.querySelector("#fileStatusText"),
        ];
        const ranges = spans.map((span) => {
          const range = document.createRange();
          range.selectNodeContents(span);
          return center(range.getBoundingClientRect());
        });
        return {
          center: center(rect),
          button: center(button.getBoundingClientRect()),
          spans: spans.map((span) => center(span.getBoundingClientRect())),
          ranges,
          height: rect.height,
          buttonHeight: button.getBoundingClientRect().height,
          right: rect.right,
          scrollWidth: document.documentElement.scrollWidth,
        };
      });
      expect(geometry.height).toBe(58);
      expect(geometry.buttonHeight).toBe(44);
      for (const center of [geometry.button, ...geometry.spans])
        expect(Math.abs(center - geometry.center)).toBeLessThanOrEqual(0.5);
      // Font glyph metrics can differ from line boxes by ~1px across engines.
      for (const center of geometry.ranges)
        expect(Math.abs(center - geometry.center)).toBeLessThanOrEqual(2);
      expect(
        Math.abs(geometry.ranges[0] - geometry.ranges[1]),
      ).toBeLessThanOrEqual(1);
      expect(geometry.right).toBeLessThanOrEqual(width);
      expect(geometry.scrollWidth).toBeLessThanOrEqual(width);
      if (process.env.MAIL_CF_SCREENSHOTS && [390, 1440].includes(width)) {
        await page.screenshot({
          path: `/root/.openclaw/media/browser/mail-cf-centered-${testInfo.project.name}-${width}-${state}.png`,
        });
      }
    }
  });
}

test("favicon loads on both pages without CSP violations", async ({ page }) => {
  const errors = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  await page.addInitScript(() => {
    window.cspViolations = [];
    document.addEventListener("securitypolicyviolation", (event) => {
      window.cspViolations.push(event.violatedDirective);
    });
  });
  await page.goto("/login");
  for (const authenticated of [false, true]) {
    if (authenticated) {
      await page.locator("#password").fill("StrongPassword123");
      await page.locator("button[type=submit]").click();
      await expect(page.locator("#compose")).toBeVisible();
    }
    await expect(page.locator('link[rel="icon"]')).toHaveAttribute(
      "href",
      "/favicon.png",
    );
    // Headless engines do not all fetch tab icons automatically. Load the exact
    // declared icon as an image so decoding and the document CSP are exercised.
    const icon = await page.evaluate(async () => {
      const link = document.querySelector('link[rel="icon"]');
      const image = new Image();
      image.src = link.href;
      await image.decode();
      return {
        origin: new URL(image.src).origin,
        pageOrigin: location.origin,
        width: image.naturalWidth,
        height: image.naturalHeight,
      };
    });
    expect(icon.origin).toBe(icon.pageOrigin);
    expect([icon.width, icon.height]).toEqual([64, 64]);
    expect(await page.evaluate(() => window.cspViolations)).toEqual([]);
  }
  expect(errors).toEqual([]);
});
