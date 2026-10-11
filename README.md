# Korail Secret Fetcher

Capture matching network requests made by Korail's English website in a local Chrome or Chromium session. The tool launches a browser, opens the Korail page, clicks its Search button, and records requests whose path starts with `/web_s/`.

> **Privacy:** Captured request and response bodies may contain sensitive data. Keep `korail-requests.jsonl` private, review it before sharing, and only use this tool with accounts and data you are authorized to access.

## Requirements

- Node.js (the current LTS release is recommended).
- Google Chrome or Chromium installed on macOS or Linux.
- An interactive terminal for the browser discovery prompt if the browser is not found automatically.

The program searches common browser installation paths and the system `PATH`. To point it to a non-standard installation, set `CHROME_PATH` or `CHROMIUM_PATH` to the browser executable before starting the command.

```sh
export CHROME_PATH="/path/to/chrome-or-chromium"
```

## Install and run

After this package is published to npm, run it once with:

```sh
npx korail-secret-fetcher
```

Or install it globally and invoke the command directly:

```sh
npm install --global korail-secret-fetcher
korail-secret-fetcher
```

There are currently no command-line options. Run the command from the directory where you want the output file saved.

## What to expect

1. The tool starts Chrome/Chromium with a temporary browser profile and a local debugging endpoint.
2. It opens the Korail English page and waits for it to load and initialize.
3. It finds and clicks the page's **Search** button, then listens for matching `/web_s/` requests.
4. Each completed matching request is appended as a JSON object on its own line to `korail-requests.jsonl` in the current working directory. Records include request details and, when available, the response body.
5. After the first matching request is found, the browser is left open. Close it manually when finished; the temporary profile is removed after the browser exits.

The output path is based on the directory from which you launch the command, not the package installation directory.

## Run from a source checkout

```sh
npm install
npm run build
npm start
```

For a local `korail-secret-fetcher` command during development, build first and link the package:

```sh
npm run build
npm link
korail-secret-fetcher
```

Useful project scripts:

| Script          | Purpose                          |
| --------------- | -------------------------------- |
| `npm run build` | Compile TypeScript into `dist/`. |
| `npm start`     | Build, then run the CLI.         |
| `npm run lint`  | Run Oxlint.                      |
| `npm run fmt`   | Format the project with Oxfmt.   |

## Troubleshooting

- **Browser not found:** Install Chrome/Chromium or set `CHROME_PATH`/`CHROMIUM_PATH` to its executable. If prompted, press Enter after installing the browser so discovery can run again.
- **Browser exits before connecting:** Confirm that the executable is runnable and that another security policy is not preventing it from starting.
- **No matching request:** The tool waits up to 30 seconds after clicking Search. Confirm the Korail page loaded correctly and that the search interaction produced a request with a `/web_s/` path.
- **Output file is not where expected:** Check the current working directory used to launch the command.
