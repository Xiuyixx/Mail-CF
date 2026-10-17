import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./browser-tests",
  fullyParallel: true,
  workers: 3,
  reporter: "list",
  use: {
    baseURL: "https://127.0.0.1:8789",
    ignoreHTTPSErrors: true,
    screenshot: "only-on-failure",
  },
  projects: ["chromium", "firefox", "webkit"].map((browserName) => ({
    name: browserName,
    use: { browserName },
  })),
  webServer: {
    command: "node browser-tests/server.js",
    url: "https://127.0.0.1:8789/login",
    reuseExistingServer: false,
    ignoreHTTPSErrors: true,
  },
});
