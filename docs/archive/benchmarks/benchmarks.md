# WSI Streaming Benchmarks

## Objective

The WSI Viewer POC includes two complementary benchmark approaches:

1. direct DICOMweb performance testing;
2. end-to-end browser testing of the deployed viewer.

They evaluate different parts of the system and should not be interpreted as equivalent measurements.

---

# 1. DICOMweb benchmark

File:

```text
benchmarks/benchmark_dicomweb.py
```

## Purpose

This benchmark evaluates the DICOMweb backend directly without involving the browser or rendering layer.

Architecture under test:

```text
benchmark_dicomweb.py
        │
        ▼
Cloudflare / DICOMweb endpoint
        │
        ▼
Orthanc
```

## Inputs

The script receives:

```text
--base-url
--study
--series
--runs
--output
```

Example:

```bash
python3 benchmarks/benchmark_dicomweb.py \
  --base-url https://example-endpoint/dicom-web \
  --study "$STUDY" \
  --series "$SERIES" \
  --runs 5 \
  --output benchmark_dicomweb.csv
```

## Metadata test

For each run, the benchmark first retrieves:

```text
/studies/{StudyInstanceUID}
/series/{SeriesInstanceUID}
/metadata
```

The following metrics are recorded:

- HTTP status
- TTFB
- total transfer time
- transferred bytes
- throughput

## WSI pyramid identification

The returned metadata is inspected to identify DICOM instances whose `ImageType` corresponds to:

```text
VOLUME
```

For every detected level, the script obtains:

- SOP Instance UID
- Total Pixel Matrix Columns
- Total Pixel Matrix Rows
- Number of Frames

Levels are sorted from highest to lowest total pixel resolution.

The resulting conceptual structure is:

```text
L0 — highest resolution
L1
L2
...
Ln — lowest resolution
```

## Frame sampling

For every `VOLUME` level, three representative frames are selected:

```text
first frame
middle frame
last frame
```

Therefore, these three frames must not be interpreted as three zoom levels.

Example:

```text
L0
├── first frame
├── middle frame
└── last frame

L1
├── first frame
├── middle frame
└── last frame

L2
├── first frame
├── middle frame
└── last frame
```

For each frame request, the benchmark records:

- level
- resolution
- frame number
- HTTP status
- TTFB
- total transfer time
- bytes
- throughput

## Output

Results are stored in CSV format with the columns:

```text
run
tipo
nivel
resolucion
frame
status
ttfb_ms
total_ms
bytes
throughput_mbps
```

This benchmark is useful for separating backend/network performance from frontend rendering performance.

---

# 2. End-to-end browser benchmark

File:

```text
benchmarks/benchmark-e2e.mjs
```

## Purpose

This test evaluates the deployed viewer from the perspective of a real browser session.

The script uses Playwright and Chromium.

Architecture under test:

```text
Playwright / Chromium
        │
        ▼
Vercel frontend
        │
        ▼
Cloudflare / DICOMweb
        │
        ▼
Orthanc
        │
        ▼
metadata + frames
        │
        ▼
browser rendering
```

The default frontend is:

```text
https://wsi-viewer-poc.vercel.app
```

It can be overridden using:

```text
FRONTEND_URL
```

## Runs

The default number of executions is:

```text
5
```

and can be changed using:

```text
RUNS
```

## Measurements

For each run, the benchmark records:

### DOMContentLoaded

Time required for the HTML document to reach `DOMContentLoaded`.

### Metadata

Elapsed time until the first response whose URL contains:

```text
/metadata
```

### Bulk/ICC data

Elapsed time until traffic associated with bulk data or ICC information is detected.

### First frame

Elapsed time until the first response whose URL contains:

```text
/frames/
```

### Viewer initialized

The benchmark waits until the element:

```text
#status
```

contains:

```text
Visor inicializado
```

### Canvas

The benchmark waits for:

```text
#viewport canvas
```

which indicates that the OpenLayers rendering surface has been attached.

### Frame traffic

During the observation window it records:

- number of frame responses;
- total frame bytes transferred.

### Failed requests

Playwright records requests that fail and stores:

- URL
- reported error.

### Total elapsed time

Total benchmark execution time for the browser run.

## Output metrics

The CSV contains metrics including:

```text
run
dom_content_loaded_ms
metadata_ms
bulk_ms
first_frame_ms
viewer_status_ms
canvas_ms
observation_ms
frame_responses
frame_bytes
failed_requests
total_ms
status
failures
```

## Screenshots

A screenshot is generated for every execution:

```text
benchmark-run-1.png
benchmark-run-2.png
...
```

This provides visual evidence of the viewer state reached during each benchmark run.

---

# What the current E2E benchmark does NOT measure

The current version evaluates the initial loading process of the viewer.

It does not currently automate:

- zoom-in;
- zoom-out;
- pan movements;
- navigation between predefined regions;
- response latency after a viewport interaction.

Therefore it should currently be described as:

```text
initial-load end-to-end benchmark
```

rather than a complete interactive navigation benchmark.

A future extension could define standardized viewport interactions such as:

```text
Initial view
    ↓
Zoom level A
    ↓
Pan to predefined region
    ↓
Zoom level B
    ↓
Pan
    ↓
Zoom level C
```

and measure the frame requests and rendering latency generated by each interaction.

---

# Interpretation

The two benchmarks answer different questions.

## DICOMweb benchmark

```text
How quickly can the backend deliver metadata and WSI frames?
```

It isolates:

- DICOMweb;
- backend response;
- network transfer.

## End-to-end benchmark

```text
How quickly does the remotely deployed system become usable in a browser?
```

It includes:

- Vercel;
- browser initialization;
- frontend JavaScript;
- DICOMweb requests;
- Cloudflare/backend path;
- WSI viewer initialization;
- initial rendering.

Using both measurements helps distinguish backend bottlenecks from frontend or browser-side latency.