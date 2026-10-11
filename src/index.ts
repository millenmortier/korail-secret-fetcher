import CDP from "chrome-remote-interface";
import { appendFile, access, mkdtemp, rm } from "node:fs/promises";
import { constants } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";

const START_URL = "https://korail.com/global/eng/intro";
const REQUEST_LOG = path.resolve(process.cwd(), "korail-requests.jsonl");
const DEBUG_HOST = "127.0.0.1";

function candidateBrowserPaths(): string[] {
  const envPath = process.env.CHROME_PATH ?? process.env.CHROMIUM_PATH;
  const paths = envPath ? [envPath] : [];
  const home = process.env.HOME ?? "";

  if (process.platform === "darwin") {
    paths.push(
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
      "/Applications/Chromium.app/Contents/MacOS/Chromium",
      path.join(
        home,
        "Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      ),
      path.join(home, "Applications/Chromium.app/Contents/MacOS/Chromium"),
    );
  } else if (process.platform === "linux") {
    paths.push(
      "/usr/bin/google-chrome",
      "/usr/bin/google-chrome-stable",
      "/usr/bin/chromium",
      "/usr/bin/chromium-browser",
      "/opt/google/chrome/chrome",
      "/snap/bin/chromium",
      "/var/lib/flatpak/exports/bin/com.google.Chrome",
      "/var/lib/flatpak/exports/bin/org.chromium.Chromium",
    );
  } else {
    throw new Error(
      `Unsupported operating system: ${process.platform}. Use macOS or Linux.`,
    );
  }

  for (const directory of (process.env.PATH ?? "").split(path.delimiter)) {
    for (const binary of [
      "google-chrome",
      "google-chrome-stable",
      "chromium",
      "chromium-browser",
    ]) {
      paths.push(path.join(directory, binary));
    }
  }

  return [...new Set(paths.filter(Boolean))];
}

async function findBrowser(): Promise<string | undefined> {
  for (const candidate of candidateBrowserPaths()) {
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Keep checking common locations and PATH entries.
    }
  }
  return undefined;
}

async function promptForChromium(): Promise<string> {
  const readline = createInterface({ input: stdin, output: stdout });
  try {
    await readline.question(
      "Chrome/Chromium was not found. Please install Chromium, then press Enter to search again (Ctrl+C to cancel): ",
    );
  } finally {
    readline.close();
  }

  const browser = await findBrowser();
  if (!browser) {
    throw new Error(
      "Chromium is still not available. Install it or set CHROME_PATH, then retry.",
    );
  }
  return browser;
}

async function findFreePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, DEBUG_HOST, () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("Could not reserve a local debugging port.");
  }
  const { port } = address;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  return port;
}

async function waitForCdp(port: number, browser: ChildProcess): Promise<void> {
  const deadline = Date.now() + 20_000;
  let lastError: unknown;

  while (Date.now() < deadline) {
    if (browser.exitCode !== null) {
      throw new Error(
        `Chrome exited before CDP became available (exit code ${browser.exitCode}).`,
      );
    }
    try {
      const response = await fetch(`http://${DEBUG_HOST}:${port}/json/version`);
      if (response.ok) return;
    } catch (error) {
      lastError = error;
    }
    await delay(200);
  }

  throw new Error(
    `Timed out waiting for Chrome's CDP endpoint: ${String(lastError ?? "no response")}`,
  );
}

async function stopBrowser(browser: ChildProcess): Promise<void> {
  if (browser.exitCode !== null || browser.killed) return;
  const exited = new Promise<void>((resolve) =>
    browser.once("exit", () => resolve()),
  );
  browser.kill("SIGTERM");
  await Promise.race([exited, delay(3_000)]);
  if (browser.exitCode === null) browser.kill("SIGKILL");
}

export async function main(): Promise<void> {
  let browserPath = await findBrowser();
  if (!browserPath) browserPath = await promptForChromium();

  const port = await findFreePort();
  const profileDirectory = await mkdtemp(path.join(tmpdir(), "korail-cdp-"));
  const args = [
    `--remote-debugging-address=${DEBUG_HOST}`,
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profileDirectory}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-networking",
    // ...(process.env.CHROME_HEADLESS === "0" ? [] : ["--headless=new"]),
  ];

  let browser: ChildProcess | undefined;
  let client: Awaited<ReturnType<typeof CDP>> | undefined;
  let keepBrowserOpen = false;
  try {
    browser = spawn(browserPath, args, { stdio: "ignore" });
    console.log(`Chrome remote debugging endpoint: ${DEBUG_HOST}:${port}`);
    await waitForCdp(port, browser);
    client = await CDP({
      host: DEBUG_HOST,
      port,
      target: (targets) => targets.find((target) => target.type === "page")!,
    });

    const { Page, Network, Runtime, Input } = client;
    await Promise.all([Page.enable(), Network.enable({})]);

    let resolveRequest!: (record: CapturedRequest) => void;
    const matchingRequest = new Promise<CapturedRequest>((resolve) => {
      resolveRequest = resolve;
    });
    const capturedIds = new Set<string>();
    const pendingRequests = new Map<
      string,
      { record: CapturedRequest; requestBodyReady: Promise<void> }
    >();

    Network.requestWillBeSent(async ({ requestId, request }) => {
      let parsedUrl: URL;
      try {
        parsedUrl = new URL(request.url);
      } catch {
        return;
      }
      if (
        !parsedUrl.pathname.startsWith("/web_s/") ||
        capturedIds.has(requestId)
      )
        return;
      capturedIds.add(requestId);

      const record: CapturedRequest = {
        timestamp: new Date().toISOString(),
        method: request.method,
        path: `${parsedUrl.pathname}${parsedUrl.search}`,
        url: request.url,
        body: request.postData ?? "",
      };
      const requestBodyReady = (async () => {
        if (!record.body && request.hasPostData) {
          try {
            record.body = (
              await Network.getRequestPostData({ requestId })
            ).postData;
          } catch {
            // Some browser requests do not expose a body after the initial event.
          }
        }
      })();
      pendingRequests.set(requestId, { record, requestBodyReady });
    });

    Network.loadingFinished(async ({ requestId }) => {
      const pending = pendingRequests.get(requestId);
      if (!pending) return;
      pendingRequests.delete(requestId);
      await pending.requestBodyReady;
      const { record } = pending;

      try {
        const response = await Network.getResponseBody({ requestId });
        record.responseBody = response.body;
        record.responseBodyBase64Encoded = response.base64Encoded;
      } catch (error) {
        record.responseBodyError =
          error instanceof Error ? error.message : String(error);
      }

      await appendFile(REQUEST_LOG, `${JSON.stringify(record)}\n`, "utf8");
      console.log("Captured Korail request:");
      console.log(JSON.stringify(record, null, 2));
      resolveRequest(record);
    });

    const pageLoaded = Page.loadEventFired();
    await Page.navigate({ url: START_URL });
    await Promise.race([
      pageLoaded,
      delay(30_000).then(() => {
        throw new Error("Timed out waiting for the Korail page load event.");
      }),
    ]);
    console.log(`Page loaded: ${START_URL}`);

    console.log("Waiting for 10 seconds to make sure everything's initialized");
    await delay(10_000);
    console.log("Running script to find button position");

    const buttonPosition = await Runtime.evaluate({
      expression: `new Promise((resolve) => {
        const deadline = Date.now() + 20000;
        const findButton = () => {
          const button = [...document.querySelectorAll('button[class="search_btn"]')]
            .find((element) => element.textContent?.trim() === "Search");
          if (button) {
            const rect = button.getBoundingClientRect();
            if (rect.width > 0 && rect.height > 0) {
              resolve({ x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 });
              return;
            }
          }
          if (Date.now() >= deadline) {
            resolve(null);
          } else {
            setTimeout(findButton, 200);
          }
        };
        findButton();
      })`,
      awaitPromise: true,
      returnByValue: true,
    });

    const position = buttonPosition.result.value as {
      x: number;
      y: number;
    } | null;

    console.log({ position });

    if (!position) {
      throw new Error(
        'Could not find a <button class="search_btn">Search</button> on the loaded page.',
      );
    }

    console.log("Simulating button click");
    await Input.dispatchMouseEvent({
      type: "mouseMoved",
      x: position.x,
      y: position.y,
    });
    await Input.dispatchMouseEvent({
      type: "mousePressed",
      x: position.x,
      y: position.y,
      button: "left",
      clickCount: 1,
    });
    await Input.dispatchMouseEvent({
      type: "mouseReleased",
      x: position.x,
      y: position.y,
      button: "left",
      clickCount: 1,
    });
    console.log("Clicked the Search button; listening for /web_s/ requests...");

    try {
      await Promise.race([
        matchingRequest,
        delay(30_000).then(() => {
          throw new Error(
            "No request with a /web_s/ path was observed within 30 seconds.",
          );
        }),
      ]);
      keepBrowserOpen = true;
      console.log(`Request saved to ${REQUEST_LOG}`);
      console.log("Browser left open. Close it manually when finished.");
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("No request")) {
        console.warn(error.message);
      } else {
        throw error;
      }
    }
  } finally {
    if (client) await client.close().catch(() => undefined);
    if (keepBrowserOpen && browser) {
      browser.once("exit", () => {
        void rm(profileDirectory, { recursive: true, force: true });
      });
      browser.unref();
    } else {
      if (browser) await stopBrowser(browser);
      await rm(profileDirectory, { recursive: true, force: true });
    }
  }
}

interface CapturedRequest {
  timestamp: string;
  method: string;
  path: string;
  url: string;
  body: string;
  responseBody?: string;
  responseBodyBase64Encoded?: boolean;
  responseBodyError?: string;
}

