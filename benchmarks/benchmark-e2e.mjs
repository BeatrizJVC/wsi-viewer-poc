import { chromium } from "playwright";
import fs from "fs";

const FRONTEND_URL =
    process.env.FRONTEND_URL ||
    "https://wsi-viewer-poc.vercel.app";

const RUNS = Number(process.env.RUNS || 5);

const OUTPUT =
    process.env.OUTPUT ||
    "benchmark_e2e.csv";

const OBSERVATION_MS =
    Number(process.env.OBSERVATION_MS || 5000);

const rows = [];

const sleep = (ms) =>
    new Promise(resolve => setTimeout(resolve, ms));


for (let run = 1; run <= RUNS; run++) {

    console.log(`\n===== RUN ${run}/${RUNS} =====`);

    const browser = await chromium.launch({
        headless: true,
    });

    const context = await browser.newContext({
        bypassCSP: true,
    });

    const page = await context.newPage();

    const start = performance.now();

    let metadataAt = null;
    let bulkAt = null;
    let firstFrameAt = null;
    let canvasAt = null;
    let viewerStatusAt = null;

    let frameResponses = 0;
    let frameBytes = 0;
    let failedRequests = 0;

    const failures = [];

    page.on("requestfailed", request => {
        failedRequests++;

        failures.push({
            url: request.url(),
            error:
                request.failure()?.errorText || "unknown",
        });
    });

    page.on("response", async response => {

        const url = response.url();

        const elapsed =
            performance.now() - start;

        if (
            metadataAt === null &&
            url.includes("/metadata")
        ) {
            metadataAt = elapsed;
        }

        if (
            bulkAt === null &&
            (
                url.includes("/bulk/") ||
                url.includes("00282000")
            )
        ) {
            bulkAt = elapsed;
        }

        if (url.includes("/frames/")) {

            frameResponses++;

            if (firstFrameAt === null) {
                firstFrameAt = elapsed;
            }

            const headers =
                await response.allHeaders();

            const contentLength =
                Number(
                    headers["content-length"] || 0
                );

            frameBytes += contentLength;
        }
    });

    const navigationStart =
        performance.now();

    await page.goto(
        FRONTEND_URL,
        {
            waitUntil: "domcontentloaded",
            timeout: 120000,
        }
    );

    const domContentLoaded =
        performance.now() - navigationStart;

    // Esperar estado del viewer
    try {
        await page.waitForFunction(
            () => {
                const status =
                    document.querySelector("#status");

                return (
                    status &&
                    status.textContent.includes(
                        "Visor inicializado"
                    )
                );
            },
            {
                timeout: 120000,
            }
        );

        viewerStatusAt =
            performance.now() - start;

    } catch {
        console.log(
            "No se detectó estado de visor inicializado"
        );
    }

    // Esperar primer frame
    const firstFrameDeadline =
        Date.now() + 120000;

    while (
        firstFrameAt === null &&
        Date.now() < firstFrameDeadline
    ) {
        await sleep(100);
    }

    // Esperar canvas OpenLayers
    try {
        await page.waitForSelector(
            "#viewport canvas",
            {
                state: "attached",
                timeout: 30000,
            }
        );

        canvasAt =
            performance.now() - start;

    } catch {
        console.log(
            "No se detectó canvas"
        );
    }

    // Observar tráfico durante algunos segundos
    await sleep(OBSERVATION_MS);

    const statusText =
        await page.locator("#status")
            .textContent()
            .catch(() => "");

    const totalElapsed =
        performance.now() - start;

    console.log(
        `DOMContentLoaded: ${domContentLoaded.toFixed(1)} ms`
    );

    console.log(
        `Metadata: ${metadataAt?.toFixed(1) ?? "N/A"
        } ms`
    );

    console.log(
        `Bulk/ICC: ${bulkAt?.toFixed(1) ?? "N/A"
        } ms`
    );

    console.log(
        `Primer frame: ${firstFrameAt?.toFixed(1) ?? "N/A"
        } ms`
    );

    console.log(
        `Canvas: ${canvasAt?.toFixed(1) ?? "N/A"
        } ms`
    );

    console.log(
        `Frames recibidos: ${frameResponses}`
    );

    console.log(
        `Transferencia frames: ${(frameBytes / 1024 / 1024).toFixed(2)
        } MB`
    );

    console.log(
        `Estado: ${statusText}`
    );

    rows.push({
        run,
        dom_content_loaded_ms:
            domContentLoaded.toFixed(2),

        metadata_ms:
            metadataAt?.toFixed(2) ?? "",

        bulk_ms:
            bulkAt?.toFixed(2) ?? "",

        first_frame_ms:
            firstFrameAt?.toFixed(2) ?? "",

        viewer_status_ms:
            viewerStatusAt?.toFixed(2) ?? "",

        canvas_ms:
            canvasAt?.toFixed(2) ?? "",

        observation_ms:
            OBSERVATION_MS,

        frame_responses:
            frameResponses,

        frame_bytes:
            frameBytes,

        failed_requests:
            failedRequests,

        total_ms:
            totalElapsed.toFixed(2),

        status:
            JSON.stringify(statusText),

        failures:
            JSON.stringify(failures),
    });

    await page.screenshot({
        path: `benchmark-run-${run}.png`,
        fullPage: true,
    });

    await browser.close();
}


// CSV
const headers = Object.keys(rows[0]);

const escapeCsv = value => {
    const string =
        String(value ?? "");

    return `"${string.replaceAll('"', '""')}"`;
};

const csv = [
    headers.join(","),
    ...rows.map(row =>
        headers
            .map(h => escapeCsv(row[h]))
            .join(",")
    ),
].join("\n");

fs.writeFileSync(
    OUTPUT,
    csv,
    "utf8"
);

console.log(`\nCSV guardado en ${OUTPUT}`);