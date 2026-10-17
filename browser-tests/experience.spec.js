import { test, expect } from "@playwright/test";

async function compose(page) {
  await page.goto("/login");
  await page.locator("#password").fill("StrongPassword123");
  await page.locator("button[type=submit]").click();
  await expect(page.locator("#compose")).toBeVisible();
  await page.locator("#to").fill("a@example.net");
  await page.locator("#fromPrefix").fill("noreply");
  await page.locator("#subject").fill("Test");
  await page.locator("#text").fill("Body");
}

for (const login of [true, false]) {
  test(`${login ? "login" : "send"} loading, error protection and recovery`, async ({
    page,
  }) => {
    if (login) {
      await page.goto("/login");
      await page.locator("#password").fill("StrongPassword123");
    } else await compose(page);
    const button = page.locator(login ? "button[type=submit]" : "#send");
    const endpoint = login ? "**/login" : "**/api/send";
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    let calls = 0;
    await page.route(endpoint, async (route) => {
      calls++;
      await gate;
      await route.fulfill({
        status: 503,
        contentType: "text/html",
        body: "<h1>Unavailable</h1>",
      });
    });
    await button.click();
    await expect(button).toBeDisabled();
    await expect(button).toHaveText(login ? "登录中…" : "发送中…");
    await page
      .locator(login ? "#login" : "#compose")
      .evaluate((form) =>
        form.dispatchEvent(new Event("submit", { cancelable: true })),
      );
    release();
    await expect(page.locator("#message")).toHaveText("请求失败（HTTP 503）");
    expect(calls).toBe(1);
    await expect(button).toBeEnabled();
    await expect(button).toHaveText(login ? "登录" : "发送");
    await page.unroute(endpoint);
    await page.route(endpoint, (route) => route.abort());
    await button.click();
    await expect(page.locator("#message")).toHaveText("网络错误，请稍后重试");
    await expect(button).toBeEnabled();
    await page.unroute(endpoint);
    await page.route(endpoint, (route) =>
      route.fulfill({
        status: 429,
        contentType: "application/json",
        body: '{"error":"请求过于频繁"}',
      }),
    );
    await button.click();
    await expect(page.locator("#message")).toHaveText("请求过于频繁");
    await page.unroute(endpoint);
    await page.route(endpoint, (route) =>
      route.fulfill({
        status: 502,
        contentType: "application/json",
        body: "null",
      }),
    );
    await button.click();
    await expect(page.locator("#message")).toHaveText("请求失败（HTTP 502）");
  });
}

test("attachment limits block reads and requests before upload", async ({
  page,
}) => {
  await compose(page);
  await page.evaluate(() => {
    window.fileReads = 0;
    window.sendCalls = 0;
    FileReader.prototype.readAsDataURL = function () {
      window.fileReads++;
    };
    const original = window.fetch;
    window.fetch = (...args) => {
      window.sendCalls++;
      return original(...args);
    };
  });
  for (const [sizes, error] of [
    [[10 * 1024 * 1024 + 1], "超过 10 MiB 限制"],
    [
      [9 * 1024 * 1024, 9 * 1024 * 1024, 9 * 1024 * 1024],
      "附件总大小超过 25 MiB 限制",
    ],
  ]) {
    while (await page.locator(".file-remove").count()) {
      await page.locator(".file-remove").first().click();
    }
    await page.locator("#files").evaluate((input, sizes) => {
      const data = new DataTransfer();
      sizes.forEach((size, i) =>
        data.items.add(new File([new Uint8Array(size)], `file${i}.txt`)),
      );
      input.files = data.files;
      input.dispatchEvent(new Event("change"));
    }, sizes);
    await expect(page.locator("#message")).toContainText(error);
    await page.locator("#send").click();
    await expect(page.locator("#message")).toContainText(error);
    expect(
      await page.evaluate(() => [window.fileReads, window.sendCalls]),
    ).toEqual([0, 0]);
    await expect(page.locator("#send")).toBeEnabled();
  }
});

test("separate attachment selections append and send all files", async ({
  page,
}) => {
  await compose(page);
  await page.locator("#files").setInputFiles({
    name: "first.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("first"),
  });
  await page.locator("#files").setInputFiles({
    name: "second.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("second"),
  });
  await expect(page.locator(".file-item")).toHaveCount(2);
  await expect(page.locator("#fileNames")).toContainText("first.txt");
  await expect(page.locator("#fileNames")).toContainText("second.txt");

  let payload;
  await page.route("**/api/send", async (route) => {
    payload = JSON.parse(route.request().postData());
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ok: true }),
    });
  });
  await page.locator("#send").click();
  await expect(page.locator("#message")).toHaveText("发送成功");
  expect(payload.attachments.map((attachment) => attachment.filename)).toEqual([
    "first.txt",
    "second.txt",
  ]);
});

test("attachment remove buttons update the files to send", async ({ page }) => {
  await compose(page);
  await page.locator("#files").setInputFiles([
    { name: "keep.txt", mimeType: "text/plain", buffer: Buffer.from("keep") },
    {
      name: "remove.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("remove"),
    },
  ]);
  await expect(page.locator(".file-item")).toHaveCount(2);
  await expect(page.locator(".file-remove")).toHaveCount(2);
  await page.locator('.file-remove[aria-label="删除附件 remove.txt"]').click();
  await expect(page.locator(".file-item")).toHaveCount(1);
  await expect(page.locator("#fileNames")).toContainText("keep.txt");
  await expect(page.locator("#fileNames")).not.toContainText("remove.txt");
  await expect(page.locator("#files")).toHaveValue(/keep\.txt/);

  let payload;
  await page.route("**/api/send", async (route) => {
    payload = JSON.parse(route.request().postData());
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ok: true }),
    });
  });
  await page.locator("#send").click();
  await expect(page.locator("#message")).toHaveText("发送成功");
  expect(payload.attachments.map((attachment) => attachment.filename)).toEqual([
    "keep.txt",
  ]);
});

// Fixed metadata mirrors reselecting the same on-disk file across picker actions.
async function selectFiles(page, files) {
  await page.locator("#files").evaluate((input, files) => {
    const transfer = new DataTransfer();
    for (const { name, size = 1, lastModified = 1000 } of files) {
      transfer.items.add(
        new File([new Uint8Array(size)], name, {
          type: "text/plain",
          lastModified,
        }),
      );
    }
    input.files = transfer.files;
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }, files);
}

test("reselection deduplicates, cancellation preserves files, and removal stays removed", async ({
  page,
}) => {
  await compose(page);
  await selectFiles(page, [{ name: "a.txt" }, { name: "b.txt" }]);
  await selectFiles(page, [{ name: "a.txt" }, { name: "c.txt" }]);
  await selectFiles(page, []);
  await expect(page.locator(".file-item span")).toHaveText([
    "a.txt",
    "b.txt",
    "c.txt",
  ]);
  await page.locator('.file-remove[aria-label="删除附件 b.txt"]').click();
  await expect(
    page.locator('.file-remove[aria-label="删除附件 c.txt"]'),
  ).toBeFocused();
  await selectFiles(page, [{ name: "d.txt" }]);
  expect(
    await page
      .locator("#files")
      .evaluate((input) => [...input.files].map((file) => file.name)),
  ).toEqual(["a.txt", "c.txt", "d.txt"]);
  await selectFiles(page, [{ name: "a.txt", lastModified: 2000 }]);
  await expect(page.locator(".file-item")).toHaveCount(4);
  while (await page.locator(".file-remove").count()) {
    await page.locator(".file-remove").first().click();
  }
  await expect(page.locator("#chooseFiles")).toBeFocused();
  await selectFiles(page, [{ name: "b.txt" }]);
  await expect(page.locator(".file-item span")).toHaveText(["b.txt"]);
});

for (const limit of ["count", "total"]) {
  test(`multiple rounds enforce cumulative attachment ${limit} before reads`, async ({
    page,
  }) => {
    await compose(page);
    await page.evaluate(() => {
      window.fileReads = 0;
      window.sendCalls = 0;
      FileReader.prototype.readAsDataURL = function () {
        window.fileReads++;
      };
      window.fetch = () => {
        window.sendCalls++;
      };
    });
    const first =
      limit === "count"
        ? Array.from({ length: 10 }, (_, i) => ({ name: `file${i}.txt` }))
        : [
            { name: "a.txt", size: 10 * 1024 * 1024 },
            { name: "b.txt", size: 10 * 1024 * 1024 },
            { name: "c.txt", size: 5 * 1024 * 1024 },
          ];
    await selectFiles(page, first);
    await expect(page.locator("#message")).toHaveText("");
    await selectFiles(page, [{ name: "extra.txt" }]);
    const error =
      limit === "count"
        ? "附件数量超过 10 个限制"
        : "附件总大小超过 25 MiB 限制";
    await expect(page.locator("#message")).toHaveText(error);
    await page.locator("#send").click();
    await expect(page.locator("#message")).toHaveText(error);
    expect(
      await page.evaluate(() => [window.fileReads, window.sendCalls]),
    ).toEqual([0, 0]);
    await page.locator('.file-remove[aria-label="删除附件 extra.txt"]').click();
    await expect(page.locator("#message")).toHaveText("");
  });
}

test("appending resets retry key and locks attachment controls while sending", async ({
  page,
}) => {
  await compose(page);
  await selectFiles(page, [{ name: "a.txt" }]);
  const keys = [];
  let release;
  await page.route("**/api/send", async (route) => {
    keys.push(route.request().headers()["idempotency-key"]);
    if (keys.length === 3)
      await new Promise((resolve) => {
        release = resolve;
      });
    await route.fulfill({
      status: 502,
      contentType: "application/json",
      body: '{"error":"retry"}',
    });
  });
  for (let i = 0; i < 2; i++) {
    await page.locator("#send").click();
    await expect(page.locator("#message")).toHaveText("retry");
  }
  expect(keys[1]).toBe(keys[0]);
  await selectFiles(page, [{ name: "b.txt" }]);
  await page.locator("#send").click();
  await expect.poll(() => keys.length).toBe(3);
  await expect(page.locator("#files")).toBeDisabled();
  await expect(page.locator("#chooseFiles")).toBeDisabled();
  for (const button of await page.locator(".file-remove").all())
    await expect(button).toBeDisabled();
  expect(keys[2]).not.toBe(keys[1]);
  release();
  await expect(page.locator("#message")).toHaveText("retry");
  await expect(page.locator("#files")).toBeEnabled();
  await expect(page.locator("#chooseFiles")).toBeEnabled();
});
